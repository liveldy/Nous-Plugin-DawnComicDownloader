package app.dawncomic;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Process-wide cookie jar persisted as {@code <dataRoot>/cookies.json}.
 *
 * <p>The stored shape is {@code {"host": "name=value; name2=value2"}} — a single merged cookie
 * string per host, which matches what {@code cookie.set}/{@code cookie.list} expose to the page.
 * All access is synchronized because HTTP worker code and request dispatch share one instance.</p>
 */
public final class CookieJar {

    private final Path file;
    private final Map<String, String> hosts = new LinkedHashMap<>();
    private final Object lock = new Object();

    /**
     * Opens (or creates in memory) a jar backed by {@code file}.
     *
     * @param file persistence target, normally {@code <dataRoot>/cookies.json}
     */
    public CookieJar(Path file) {
        this.file = file;
        load();
    }

    /**
     * Returns the backing file.
     *
     * @return absolute path of the JSON store
     */
    public Path file() {
        return file;
    }

    private void load() {
        if (file == null || !Files.isRegularFile(file)) {
            return;
        }
        try {
            String text = new String(Files.readAllBytes(file), StandardCharsets.UTF_8);
            Object parsed = Json.parse(text);
            Map<String, Object> map = Json.asObject(parsed);
            synchronized (lock) {
                for (Map.Entry<String, Object> e : map.entrySet()) {
                    if (e.getValue() instanceof String) {
                        String host = normalizeHost(e.getKey());
                        if (!host.isEmpty()) {
                            hosts.put(host, (String) e.getValue());
                        }
                    }
                }
            }
        } catch (IOException | RuntimeException e) {
            System.err.println("[dawncomic] cookie jar unreadable, starting empty: " + e.getMessage());
        }
    }

    /**
     * Stores (replacing) the cookie string for one host and persists the jar.
     *
     * @param host host name such as {@code rule34.us}
     * @param cookie raw cookie string such as {@code a=1; b=2}
     */
    public void set(String host, String cookie) {
        String key = normalizeHost(host);
        synchronized (lock) {
            hosts.put(key, cookie == null ? "" : cookie.trim());
            saveLocked();
        }
    }

    /**
     * Merges {@code Set-Cookie} response headers into the jar for one host.
     *
     * @param host request host
     * @param setCookieHeaders raw header values in arrival order
     */
    public void mergeSetCookie(String host, List<String> setCookieHeaders) {
        if (setCookieHeaders == null || setCookieHeaders.isEmpty()) {
            return;
        }
        String key = normalizeHost(host);
        if (key.isEmpty()) {
            return;
        }
        boolean changed = false;
        synchronized (lock) {
            Map<String, String> pairs = parsePairs(hosts.get(key));
            for (String header : setCookieHeaders) {
                if (header == null) {
                    continue;
                }
                int semi = header.indexOf(';');
                String pair = (semi >= 0 ? header.substring(0, semi) : header).trim();
                int eq = pair.indexOf('=');
                if (eq <= 0) {
                    continue;
                }
                String name = pair.substring(0, eq).trim();
                String value = pair.substring(eq + 1).trim();
                if (name.isEmpty()) {
                    continue;
                }
                pairs.put(name, value);
                changed = true;
            }
            if (changed) {
                hosts.put(key, joinPairs(pairs));
                saveLocked();
            }
        }
    }

    /**
     * Returns the cookie string that applies to a request host.
     *
     * <p>Exact host match wins; otherwise parent domains are tried from the longest suffix down,
     * which mirrors normal RFC 6265 domain scoping closely enough for site sessions.</p>
     *
     * @param host request host
     * @return merged cookie string, or an empty string when nothing applies
     */
    public String cookieFor(String host) {
        String key = normalizeHost(host);
        synchronized (lock) {
            String exact = hosts.get(key);
            if (exact != null && !exact.isEmpty()) {
                return exact;
            }
            int dot = key.indexOf('.');
            while (dot > 0 && dot < key.length() - 1) {
                String parent = key.substring(dot + 1);
                String value = hosts.get(parent);
                if (value != null && !value.isEmpty()) {
                    return value;
                }
                dot = key.indexOf('.', dot + 1);
            }
            return "";
        }
    }

    /**
     * Returns a snapshot of every stored host.
     *
     * @return insertion-ordered copy of host &rarr; cookie
     */
    public Map<String, Object> snapshot() {
        Map<String, Object> out = new LinkedHashMap<>();
        synchronized (lock) {
            out.putAll(hosts);
        }
        return out;
    }

    /**
     * Removes one host, or every host when {@code host} is null/blank.
     *
     * @param host host to drop, or {@code null} for all
     */
    public void clear(String host) {
        synchronized (lock) {
            if (host == null || host.trim().isEmpty()) {
                hosts.clear();
            } else {
                hosts.remove(normalizeHost(host));
            }
            saveLocked();
        }
    }

    private void saveLocked() {
        if (file == null) {
            return;
        }
        try {
            Path parent = file.getParent();
            if (parent != null) {
                Files.createDirectories(parent);
            }
            StringBuilder sb = new StringBuilder(256);
            sb.append("{\n");
            boolean first = true;
            for (Map.Entry<String, String> e : hosts.entrySet()) {
                if (!first) {
                    sb.append(",\n");
                }
                first = false;
                sb.append("  ");
                sb.append(Json.stringify(e.getKey()));
                sb.append(": ");
                sb.append(Json.stringify(e.getValue()));
            }
            sb.append("\n}\n");
            Path tmp = file.resolveSibling(file.getFileName() + ".tmp");
            Files.write(tmp, sb.toString().getBytes(StandardCharsets.UTF_8));
            try {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (IOException atomicFailed) {
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING);
            }
        } catch (IOException e) {
            System.err.println("[dawncomic] cookie jar write failed: " + e.getMessage());
        }
    }

    private static Map<String, String> parsePairs(String cookie) {
        Map<String, String> out = new LinkedHashMap<>();
        if (cookie == null || cookie.isEmpty()) {
            return out;
        }
        for (String part : cookie.split(";")) {
            String trimmed = part.trim();
            int eq = trimmed.indexOf('=');
            if (eq > 0) {
                out.put(trimmed.substring(0, eq).trim(), trimmed.substring(eq + 1).trim());
            }
        }
        return out;
    }

    private static String joinPairs(Map<String, String> pairs) {
        List<String> parts = new ArrayList<>(pairs.size());
        for (Map.Entry<String, String> e : pairs.entrySet()) {
            parts.add(e.getKey() + "=" + e.getValue());
        }
        return String.join("; ", parts);
    }

    private static String normalizeHost(String host) {
        if (host == null) {
            return "";
        }
        String out = host.trim().toLowerCase(Locale.ROOT);
        // Accept "https://host/path" style input from the page as a convenience.
        int scheme = out.indexOf("://");
        if (scheme >= 0) {
            out = out.substring(scheme + 3);
        }
        int slash = out.indexOf('/');
        if (slash >= 0) {
            out = out.substring(0, slash);
        }
        int at = out.indexOf('@');
        if (at >= 0) {
            out = out.substring(at + 1);
        }
        int colon = out.indexOf(':');
        if (colon >= 0) {
            out = out.substring(0, colon);
        }
        while (out.startsWith(".")) {
            out = out.substring(1);
        }
        return out;
    }

    /**
     * Kept for symmetry with the page API; useful when a host list must be deduplicated.
     *
     * @param hosts host names to normalise
     * @return distinct normalised host names
     */
    static Set<String> normalizeAll(List<String> hosts) {
        Set<String> out = new LinkedHashSet<>();
        if (hosts != null) {
            for (String h : hosts) {
                out.add(normalizeHost(h));
            }
        }
        return out;
    }
}
