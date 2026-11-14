package app.dawncomic;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.Proxy;
import java.net.ProxySelector;
import java.net.SocketAddress;
import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Proxy selection driven by the conventional environment variables and JVM properties.
 *
 * <p>{@code java.net.http.HttpClient} ignores {@code HTTPS_PROXY}/{@code NO_PROXY} and WinINET
 * settings, so a machine whose only route to the internet is a local HTTP proxy would fail every
 * request. This selector restores the behaviour every other HTTP stack has, without hardcoding any
 * address: it reads {@code HTTPS_PROXY}, {@code HTTP_PROXY}, {@code ALL_PROXY} and {@code NO_PROXY}
 * (upper and lower case), lets {@code -Dhttps.proxyHost/-Dhttps.proxyPort} win when present, and
 * honours {@code java.net.useSystemProxies=true} by delegating to the platform selector.</p>
 */
final class EnvProxy extends ProxySelector {

    private final InetSocketAddress httpProxy;
    private final InetSocketAddress httpsProxy;
    private final List<String> noProxy;
    private final ProxySelector systemSelector;
    private final String source;

    private EnvProxy(InetSocketAddress httpProxy, InetSocketAddress httpsProxy, List<String> noProxy,
                     ProxySelector systemSelector, String source) {
        this.httpProxy = httpProxy;
        this.httpsProxy = httpsProxy;
        this.noProxy = noProxy;
        this.systemSelector = systemSelector;
        this.source = source;
    }

    /**
     * Builds a selector from the process environment and JVM properties.
     *
     * @return a configured selector, or {@code null} when the JVM should connect directly
     */
    static EnvProxy fromEnvironment() {
        Map<String, String> env = System.getenv();
        InetSocketAddress https = fromProperties("https.proxyHost", "https.proxyPort",
                "https.proxyUser", "https.proxyPassword");
        InetSocketAddress http = fromProperties("http.proxyHost", "http.proxyPort",
                "http.proxyUser", "http.proxyPassword");
        StringBuilder source = new StringBuilder();

        if (http == null) {
            InetSocketAddress fromEnv = parse(envVal(env, "http_proxy"));
            if (fromEnv != null) {
                http = fromEnv;
                source.append("HTTP_PROXY ");
            }
        } else {
            source.append("-Dhttp.proxyHost ");
        }
        if (https == null) {
            InetSocketAddress fromEnv = parse(envVal(env, "https_proxy"));
            if (fromEnv == null) {
                fromEnv = parse(envVal(env, "all_proxy"));
            }
            if (fromEnv != null) {
                https = fromEnv;
                source.append("HTTPS_PROXY ");
            }
        } else {
            source.append("-Dhttps.proxyHost ");
        }
        if (https == null && http != null) {
            https = http;
        }
        if (http == null && https != null) {
            http = https;
        }

        String noProxyValue = envVal(env, "no_proxy");
        List<String> noProxy = splitList(noProxyValue);
        String nonProxyHosts = System.getProperty("http.nonProxyHosts");
        if (nonProxyHosts != null && !nonProxyHosts.isEmpty()) {
            for (String part : nonProxyHosts.split("\\|")) {
                if (!part.trim().isEmpty()) {
                    noProxy.add(part.trim().toLowerCase(Locale.ROOT));
                }
            }
        }

        ProxySelector system = null;
        if ("true".equalsIgnoreCase(System.getProperty("java.net.useSystemProxies"))) {
            system = ProxySelector.getDefault();
            source.append("useSystemProxies ");
        }
        if (http == null && https == null && system == null) {
            return null;
        }
        return new EnvProxy(http, https, noProxy, system, source.toString().trim());
    }

    /**
     * Renders a startup log line describing what was detected.
     *
     * @return human readable summary, without credentials
     */
    String describe() {
        return "proxy https=" + format(httpsProxy) + " http=" + format(httpProxy)
                + " bypass=" + noProxy.size() + " entries (source: " + source + ")";
    }

    private static String format(InetSocketAddress address) {
        return address == null ? "direct" : address.getHostString() + ":" + address.getPort();
    }

    @Override
    public List<Proxy> select(URI uri) {
        if (uri == null || uri.getHost() == null) {
            return ProxySelector.of(null).select(uri);
        }
        String scheme = uri.getScheme() == null ? "http" : uri.getScheme().toLowerCase(Locale.ROOT);
        InetSocketAddress target = "https".equals(scheme) ? httpsProxy : httpProxy;
        if (target == null) {
            if (systemSelector != null) {
                return systemSelector.select(uri);
            }
            return List.of(Proxy.NO_PROXY);
        }
        if (bypasses(uri.getHost())) {
            return List.of(Proxy.NO_PROXY);
        }
        return List.of(new Proxy(Proxy.Type.HTTP, target));
    }

    @Override
    public void connectFailed(URI uri, SocketAddress address, IOException failure) {
        System.err.println("[dawncomic] proxy connect failed for " + uri + " via " + address
                + ": " + failure.getMessage());
    }

    /**
     * Tests a host against {@code NO_PROXY}.
     *
     * @param host request host
     * @return true when the host must be reached directly
     */
    boolean bypasses(String host) {
        if (host == null) {
            return false;
        }
        String candidate = host.toLowerCase(Locale.ROOT);
        for (String pattern : noProxy) {
            String p = pattern;
            if ("*".equals(p)) {
                return true;
            }
            int colon = p.lastIndexOf(':');
            if (colon > 0 && p.indexOf(':') == colon) {
                p = p.substring(0, colon); // strip an optional ":port"
            }
            if (p.startsWith("*.")) {
                p = p.substring(2);
            }
            while (p.startsWith(".")) {
                p = p.substring(1);
            }
            if (p.isEmpty()) {
                continue;
            }
            if (p.indexOf('/') > 0) {
                if (ipv4InCidr(candidate, p)) {
                    return true;
                }
                continue;
            }
            if (candidate.equals(p) || candidate.endsWith("." + p)) {
                return true;
            }
        }
        return false;
    }

    private static boolean ipv4InCidr(String host, String cidr) {
        int slash = cidr.indexOf('/');
        long network = ipv4(host.toLowerCase(Locale.ROOT));
        long base = ipv4(cidr.substring(0, slash).trim());
        if (network < 0 || base < 0) {
            return false;
        }
        int bits;
        try {
            bits = Integer.parseInt(cidr.substring(slash + 1).trim());
        } catch (NumberFormatException e) {
            return false;
        }
        if (bits < 0 || bits > 32) {
            return false;
        }
        long mask = bits == 0 ? 0L : (0xFFFFFFFFL << (32 - bits)) & 0xFFFFFFFFL;
        return (network & mask) == (base & mask);
    }

    private static long ipv4(String text) {
        String[] parts = text.split("\\.");
        if (parts.length != 4) {
            return -1L;
        }
        long value = 0L;
        for (String part : parts) {
            int octet;
            try {
                octet = Integer.parseInt(part.trim());
            } catch (NumberFormatException e) {
                return -1L;
            }
            if (octet < 0 || octet > 255) {
                return -1L;
            }
            value = (value << 8) | octet;
        }
        return value;
    }

    private static InetSocketAddress fromProperties(String hostKey, String portKey,
                                                    String userKey, String passwordKey) {
        String host = System.getProperty(hostKey);
        if (host == null || host.trim().isEmpty()) {
            return null;
        }
        int port = 8080;
        String configuredPort = System.getProperty(portKey);
        if (configuredPort != null) {
            try {
                port = Integer.parseInt(configuredPort.trim());
            } catch (NumberFormatException ignored) {
                port = 8080;
            }
        }
        String user = System.getProperty(userKey);
        if (user != null && System.getProperty(passwordKey) != null) {
            System.err.println("[dawncomic] proxy authentication is not supported; "
                    + "configure an unauthenticated local proxy instead");
        }
        return new InetSocketAddress(host.trim(), port);
    }

    private static InetSocketAddress parse(String value) {
        if (value == null) {
            return null;
        }
        String text = value.trim();
        if (text.isEmpty()) {
            return null;
        }
        int scheme = text.indexOf("://");
        if (scheme >= 0) {
            text = text.substring(scheme + 3);
        }
        int at = text.indexOf('@');
        if (at >= 0) {
            text = text.substring(at + 1);
        }
        int slash = text.indexOf('/');
        if (slash >= 0) {
            text = text.substring(0, slash);
        }
        String host = text;
        int port = 8080;
        if (text.startsWith("[")) {
            int close = text.indexOf(']');
            if (close > 0) {
                host = text.substring(1, close);
                if (text.length() > close + 2 && text.charAt(close + 1) == ':') {
                    port = parsePort(text.substring(close + 2), 8080);
                }
            }
        } else {
            int colon = text.lastIndexOf(':');
            if (colon > 0) {
                host = text.substring(0, colon);
                port = parsePort(text.substring(colon + 1), 8080);
            }
        }
        if (host.isEmpty()) {
            return null;
        }
        try {
            return InetSocketAddress.createUnresolved(host, port);
        } catch (RuntimeException e) {
            return null;
        }
    }

    private static int parsePort(String text, int fallback) {
        try {
            int port = Integer.parseInt(text.trim());
            return port > 0 && port <= 65535 ? port : fallback;
        } catch (NumberFormatException e) {
            return fallback;
        }
    }

    private static String envVal(Map<String, String> env, String name) {
        String lower = env.get(name.toLowerCase(Locale.ROOT));
        if (lower != null && !lower.trim().isEmpty()) {
            return lower;
        }
        return env.get(name.toUpperCase(Locale.ROOT));
    }

    private static List<String> splitList(String value) {
        List<String> out = new ArrayList<>();
        if (value == null) {
            return out;
        }
        for (String part : value.split(",")) {
            String trimmed = part.trim().toLowerCase(Locale.ROOT);
            if (!trimmed.isEmpty()) {
                out.add(trimmed);
            }
        }
        return out;
    }
}
