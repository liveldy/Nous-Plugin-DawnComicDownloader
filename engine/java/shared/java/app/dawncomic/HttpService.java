package app.dawncomic;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.HttpConnectTimeoutException;
import java.net.http.HttpTimeoutException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import javax.net.ssl.SSLException;

/**
 * HTTP surface of the DawnComicDownloader engine: {@code http.request}, {@code http.download}, {@code net.probe}
 * and {@code image.proxy}.
 *
 * <p>Redirects are never followed by the JDK client; each hop is executed here so cookies can be
 * captured from {@code Set-Cookie} on 3xx responses and so the hop count is bounded by the caller's
 * {@code redirects} parameter. TLS verification always uses the platform trust store: certificate
 * failures are reported, never bypassed.</p>
 */
public final class HttpService {

    /** Desktop Chrome UA used when the caller does not supply one. */
    private static final String DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

    private static final long DEFAULT_TIMEOUT_MS = 30_000L;
    private static final long MIN_TIMEOUT_MS = 1_000L;
    private static final long MAX_TIMEOUT_MS = 600_000L;

    /** TCP/TLS connect budget; kept below the default request timeout so failures surface fast. */
    private static final long CONNECT_TIMEOUT_SECONDS = 15L;

    /** Guard against unbounded in-memory responses for text/binary requests. */
    private static final long DEFAULT_MAX_BODY_BYTES = 24L * 1024 * 1024;

    private static final long DEFAULT_IMAGE_MAX_BYTES = 1_500_000L;
    private static final int IMAGE_CACHE_ENTRIES = 64;

    /** Headers the JDK client refuses to let callers set. */
    private static final Set<String> RESTRICTED = Set.of(
            "connection", "content-length", "expect", "host", "upgrade");

    private static final Set<Integer> REDIRECT_STATUS = Set.of(301, 302, 303, 307, 308);

    private final HttpClient client;
    private final CookieJar cookies;
    private final FileService files;

    @SuppressWarnings("serial")
    private final Map<String, Map<String, Object>> imageCache =
            new LinkedHashMap<String, Map<String, Object>>(IMAGE_CACHE_ENTRIES + 1, 0.75f, true) {
                @Override
                protected boolean removeEldestEntry(Map.Entry<String, Map<String, Object>> eldest) {
                    return size() > IMAGE_CACHE_ENTRIES;
                }
            };

    /**
     * Creates the HTTP service.
     *
     * @param files filesystem service used to authorise download targets
     * @param cookies shared cookie jar, may be {@code null} to disable cookie persistence
     */
    public HttpService(FileService files, CookieJar cookies) {
        this.files = files;
        this.cookies = cookies;
        HttpClient.Builder builder = HttpClient.newBuilder()
                .followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(CONNECT_TIMEOUT_SECONDS))
                .version(HttpClient.Version.HTTP_1_1);
        EnvProxy proxy = EnvProxy.fromEnvironment();
        if (proxy != null) {
            builder.proxy(proxy);
            System.err.println("[dawncomic] " + proxy.describe());
        } else {
            System.err.println("[dawncomic] proxy: none, direct connections");
        }
        this.client = builder.build();
    }

    /**
     * Default User-Agent, mirrored into the {@code http.agent} property at startup.
     *
     * @return the desktop Chrome UA string
     */
    public static String defaultUserAgent() {
        return DEFAULT_UA;
    }

    // ---------------------------------------------------------------- http.request

    /**
     * Performs an HTTP request with manual redirect following.
     *
     * @param params {@code url, method, headers, body, bodyBase64, binary, useCookies, redirects, timeoutMs}
     * @return {@code {status,url,headers,body,bodyBase64,bytes}}
     * @throws EngineException on invalid parameters, transport failure or timeout
     */
    public Map<String, Object> request(Map<String, Object> params) throws EngineException {
        String rawUrl = Json.str(params, "url", "");
        if (rawUrl.trim().isEmpty()) {
            throw EngineException.invalid("url is required");
        }
        String method = Json.str(params, "method", "GET").trim().toUpperCase(Locale.ROOT);
        if (method.isEmpty()) {
            method = "GET";
        }
        Map<String, Object> headers = Json.obj(params, "headers");
        byte[] body = bodyBytes(params);
        boolean binary = Json.bool(params, "binary", false);
        boolean useCookies = Json.bool(params, "useCookies", true);
        int redirects = (int) Json.num(params, "redirects", 5L, 0L, 20L);
        long timeoutMs = Json.num(params, "timeoutMs", DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        long maxBody = Json.num(params, "maxBytes", DEFAULT_MAX_BODY_BYTES, 1L, DEFAULT_MAX_BODY_BYTES);

        URI uri = parseHttpUri(rawUrl);
        String currentMethod = method;
        byte[] currentBody = body;
        int hops = 0;
        while (true) {
            HttpRequest.Builder builder = builderFor(uri, currentMethod, currentBody, headers, useCookies, timeoutMs);
            HttpResponse<InputStream> response;
            long started = System.nanoTime();
            try {
                response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            } catch (HttpConnectTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "cannot connect within " + CONNECT_TIMEOUT_SECONDS
                        + " s (check network/proxy settings): " + uri);
            } catch (HttpTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "request timed out after " + timeoutMs + " ms: " + uri);
            } catch (SSLException e) {
                throw new EngineException("E_HTTP", "TLS failure for " + uri + ": " + e.getMessage(), e);
            } catch (IOException e) {
                throw new EngineException("E_HTTP", "request failed for " + uri + ": " + rootMessage(e), e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new EngineException("E_HTTP", "request interrupted: " + uri, e);
            }
            int status = response.statusCode();
            rememberCookies(uri, response);

            String location = response.headers().firstValue("location").orElse(null);
            if (REDIRECT_STATUS.contains(status) && location != null && hops < redirects) {
                closeQuietly(response.body());
                URI next;
                try {
                    next = uri.resolve(location);
                } catch (IllegalArgumentException e) {
                    throw new EngineException("E_HTTP", "bad redirect location for " + uri + ": " + location);
                }
                if (!"http".equalsIgnoreCase(next.getScheme()) && !"https".equalsIgnoreCase(next.getScheme())) {
                    throw new EngineException("E_UNSUPPORTED", "redirect to unsupported scheme: " + next);
                }
                if (status == 303 || ((status == 301 || status == 302) && "POST".equals(currentMethod))) {
                    currentMethod = "GET";
                    currentBody = null;
                }
                uri = next;
                hops++;
                continue;
            }

            byte[] payload;
            try (InputStream in = response.body()) {
                payload = readCapped(in, maxBody);
            } catch (HttpTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "response body timed out: " + uri);
            } catch (BodyTooLarge e) {
                throw new EngineException("E_TOO_LARGE",
                        "response exceeds " + maxBody + " bytes: " + uri);
            } catch (SSLException e) {
                throw new EngineException("E_HTTP", "TLS failure for " + uri + ": " + e.getMessage(), e);
            } catch (IOException e) {
                throw new EngineException("E_HTTP", "cannot read response from " + uri + ": " + rootMessage(e), e);
            }

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("status", (long) status);
            out.put("url", uri.toString());
            out.put("headers", flatHeaders(response));
            if (binary) {
                out.put("body", "");
                out.put("bodyBase64", Base64.getEncoder().encodeToString(payload));
            } else {
                String contentType = response.headers().firstValue("content-type").orElse("");
                out.put("body", FileService.decode(payload, charsetOf(contentType)));
                out.put("bodyBase64", "");
            }
            out.put("bytes", (long) payload.length);
            System.err.println("[dawncomic] http.request " + currentMethod + " " + uri + " -> " + status
                    + " in " + ((System.nanoTime() - started) / 1_000_000L) + " ms");
            return out;
        }
    }

    // --------------------------------------------------------------- http.download

    /**
     * Streams a URL to disk inside the permitted roots.
     *
     * @param params {@code url, path, headers, useCookies, skipExisting, timeoutMs}
     * @return {@code {path,bytes,sha256,status,contentType,skipped}}
     * @throws EngineException on denial, transport failure, or non-2xx status
     */
    public Map<String, Object> download(Map<String, Object> params) throws EngineException {
        String rawUrl = Json.str(params, "url", "");
        if (rawUrl.trim().isEmpty()) {
            throw EngineException.invalid("url is required");
        }
        String rawPath = Json.str(params, "path", "");
        if (rawPath.trim().isEmpty()) {
            throw EngineException.invalid("path is required");
        }
        URI uri = parseHttpUri(rawUrl);
        Path target = files.resolveWritable(rawPath);
        Map<String, Object> headers = Json.obj(params, "headers");
        boolean useCookies = Json.bool(params, "useCookies", true);
        boolean skipExisting = Json.bool(params, "skipExisting", true);
        int redirects = (int) Json.num(params, "redirects", 5L, 0L, 20L);
        long timeoutMs = Json.num(params, "timeoutMs", DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);

        if (skipExisting && Files.isRegularFile(target)) {
            long existing = 0L;
            try {
                existing = Files.size(target);
            } catch (IOException ignored) {
                existing = 0L;
            }
            if (existing > 0L) {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("path", target.toString());
                out.put("bytes", existing);
                // Hashing an already-finished file is cheap enough up to a bound; beyond it we skip.
                out.put("sha256", existing <= 64L * 1024 * 1024 ? sha256Of(target) : "");
                out.put("status", 0L);
                out.put("contentType", "");
                out.put("skipped", true);
                System.err.println("[dawncomic] http.download skipped existing " + target + " (" + existing + " bytes)");
                return out;
            }
        }

        Path parent = target.getParent();
        if (parent != null) {
            try {
                Files.createDirectories(parent);
            } catch (IOException e) {
                throw EngineException.io("cannot create " + parent + ": " + e.getMessage(), e);
            }
        }
        Path part = target.resolveSibling(target.getFileName() + ".part");
        deleteQuietly(part);

        int hops = 0;
        while (true) {
            HttpRequest.Builder builder = builderFor(uri, "GET", null, headers, useCookies, timeoutMs);
            HttpResponse<InputStream> response;
            try {
                response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            } catch (HttpConnectTimeoutException e) {
                deleteQuietly(part);
                throw new EngineException("E_TIMEOUT", "cannot connect within " + CONNECT_TIMEOUT_SECONDS
                        + " s (check network/proxy settings): " + uri);
            } catch (HttpTimeoutException e) {
                deleteQuietly(part);
                throw new EngineException("E_TIMEOUT", "download timed out after " + timeoutMs + " ms: " + uri);
            } catch (SSLException e) {
                deleteQuietly(part);
                throw new EngineException("E_HTTP", "TLS failure for " + uri + ": " + e.getMessage(), e);
            } catch (IOException e) {
                deleteQuietly(part);
                throw new EngineException("E_HTTP", "download failed for " + uri + ": " + rootMessage(e), e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                deleteQuietly(part);
                throw new EngineException("E_HTTP", "download interrupted: " + uri, e);
            }
            int status = response.statusCode();
            rememberCookies(uri, response);
            String location = response.headers().firstValue("location").orElse(null);
            if (REDIRECT_STATUS.contains(status) && location != null && hops < redirects) {
                closeQuietly(response.body());
                try {
                    uri = uri.resolve(location);
                } catch (IllegalArgumentException e) {
                    throw new EngineException("E_HTTP", "bad redirect location for " + uri + ": " + location);
                }
                hops++;
                continue;
            }
            if (status < 200 || status >= 300) {
                closeQuietly(response.body());
                deleteQuietly(part);
                throw new EngineException("E_HTTP", "download returned HTTP " + status + " for " + uri);
            }

            long written;
            String sha;
            try (InputStream in = response.body()) {
                written = copyToFile(in, part);
                sha = sha256Of(part);
            } catch (HttpTimeoutException e) {
                deleteQuietly(part);
                throw new EngineException("E_TIMEOUT", "download body timed out: " + uri);
            } catch (SSLException e) {
                deleteQuietly(part);
                throw new EngineException("E_HTTP", "TLS failure for " + uri + ": " + e.getMessage(), e);
            } catch (IOException e) {
                deleteQuietly(part);
                throw new EngineException("E_IO", "cannot write " + part + ": " + rootMessage(e), e);
            }

            try {
                try {
                    Files.move(part, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                } catch (IOException atomicFailed) {
                    Files.move(part, target, StandardCopyOption.REPLACE_EXISTING);
                }
            } catch (IOException e) {
                deleteQuietly(part);
                throw EngineException.io("cannot move download into place: " + target + ": " + e.getMessage(), e);
            }

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("path", target.toString());
            out.put("bytes", written);
            out.put("sha256", sha);
            out.put("status", (long) status);
            out.put("contentType", response.headers().firstValue("content-type").orElse(""));
            out.put("skipped", false);
            System.err.println("[dawncomic] http.download " + uri + " -> " + target + " (" + written + " bytes)");
            return out;
        }
    }

    // ------------------------------------------------------------------ net.probe

    /**
     * Cheap availability probe: HEAD, falling back to a ranged GET when HEAD is refused.
     *
     * @param params {@code url, timeoutMs}
     * @return {@code {status,contentType,bytes,finalUrl}}
     * @throws EngineException when both attempts fail at the transport level
     */
    public Map<String, Object> probe(Map<String, Object> params) throws EngineException {
        String rawUrl = Json.str(params, "url", "");
        if (rawUrl.trim().isEmpty()) {
            throw EngineException.invalid("url is required");
        }
        long timeoutMs = Json.num(params, "timeoutMs", 15_000L, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
        Map<String, Object> head = probeOnce(rawUrl, "HEAD", null, timeoutMs);
        long status = ((Long) head.get("status")).longValue();
        long size = ((Long) head.get("bytes")).longValue();
        // Many CDNs answer HEAD with 200 but no Content-Length; a one-byte ranged GET fills it in.
        if (status >= 400L || status == 0L || size <= 0L) {
            Map<String, Object> range = probeOnce(rawUrl, "GET", "bytes=0-0", timeoutMs);
            if (((Long) range.get("status")).longValue() != 0L) {
                head = range;
            }
        }
        return head;
    }

    private Map<String, Object> probeOnce(String rawUrl, String method, String range, long timeoutMs)
            throws EngineException {
        URI uri = parseHttpUri(rawUrl);
        int hops = 0;
        while (true) {
            HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofMillis(timeoutMs))
                    .method(method, HttpRequest.BodyPublishers.noBody());
            builder.header("User-Agent", DEFAULT_UA);
            builder.header("Accept", "*/*");
            if (range != null) {
                builder.header("Range", range);
            }
            String cookie = cookies == null ? "" : cookies.cookieFor(uri.getHost());
            if (!cookie.isEmpty()) {
                builder.header("Cookie", cookie);
            }
            HttpResponse<Void> response;
            try {
                response = client.send(builder.build(), HttpResponse.BodyHandlers.discarding());
            } catch (HttpConnectTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "cannot connect within " + CONNECT_TIMEOUT_SECONDS
                        + " s (check network/proxy settings): " + uri);
            } catch (HttpTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "probe timed out after " + timeoutMs + " ms: " + uri);
            } catch (SSLException e) {
                throw new EngineException("E_HTTP", "TLS failure for " + uri + ": " + e.getMessage(), e);
            } catch (IOException e) {
                Map<String, Object> failed = new LinkedHashMap<>();
                failed.put("status", 0L);
                failed.put("contentType", "");
                failed.put("bytes", 0L);
                failed.put("finalUrl", uri.toString());
                System.err.println("[dawncomic] net.probe failed: " + rootMessage(e));
                return failed;
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new EngineException("E_HTTP", "probe interrupted: " + uri, e);
            }
            rememberCookies(uri, response);
            int status = response.statusCode();
            String location = response.headers().firstValue("location").orElse(null);
            if (REDIRECT_STATUS.contains(status) && location != null && hops < 5) {
                try {
                    uri = uri.resolve(location);
                } catch (IllegalArgumentException e) {
                    break;
                }
                hops++;
                continue;
            }
            long bytes = 0L;
            String contentRange = response.headers().firstValue("content-range").orElse("");
            String contentLength = response.headers().firstValue("content-length").orElse("");
            try {
                bytes = Long.parseLong(contentLength.trim());
            } catch (NumberFormatException ignored) {
                bytes = 0L;
            }
            int slash = contentRange.indexOf('/');
            if (slash > 0) {
                try {
                    bytes = Long.parseLong(contentRange.substring(slash + 1).trim());
                } catch (NumberFormatException ignored) {
                    // keep content-length value
                }
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("status", (long) status);
            out.put("contentType", response.headers().firstValue("content-type").orElse(""));
            out.put("bytes", bytes);
            out.put("finalUrl", uri.toString());
            return out;
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("status", 0L);
        out.put("contentType", "");
        out.put("bytes", 0L);
        out.put("finalUrl", uri.toString());
        return out;
    }

    // ---------------------------------------------------------------- image.proxy

    /**
     * Fetches an image and returns it as a data URL for the sandboxed iframe.
     *
     * @param params {@code url, maxBytes, referer}
     * @return {@code {dataUrl,bytes,mime}}
     * @throws EngineException {@code E_TOO_LARGE}, {@code E_UNSUPPORTED} for non-image content
     */
    public Map<String, Object> imageProxy(Map<String, Object> params) throws EngineException {
        String rawUrl = Json.str(params, "url", "");
        if (rawUrl.trim().isEmpty()) {
            throw EngineException.invalid("url is required");
        }
        long maxBytes = Json.num(params, "maxBytes", DEFAULT_IMAGE_MAX_BYTES, 1L, 32L * 1024 * 1024);
        String referer = Json.str(params, "referer", null);

        synchronized (imageCache) {
            Map<String, Object> cached = imageCache.get(rawUrl);
            if (cached != null) {
                return new LinkedHashMap<>(cached);
            }
        }

        URI uri = parseHttpUri(rawUrl);
        int hops = 0;
        while (true) {
            HttpRequest.Builder builder = HttpRequest.newBuilder(uri)
                    .timeout(Duration.ofMillis(DEFAULT_TIMEOUT_MS))
                    .GET();
            builder.header("User-Agent", DEFAULT_UA);
            builder.header("Accept", "image/avif,image/webp,image/png,image/*;q=0.8,*/*;q=0.5");
            if (referer != null && !referer.isEmpty()) {
                builder.header("Referer", referer);
            }
            String cookie = cookies == null ? "" : cookies.cookieFor(uri.getHost());
            if (!cookie.isEmpty()) {
                builder.header("Cookie", cookie);
            }
            HttpResponse<InputStream> response;
            try {
                response = client.send(builder.build(), HttpResponse.BodyHandlers.ofInputStream());
            } catch (HttpConnectTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "cannot connect within " + CONNECT_TIMEOUT_SECONDS
                        + " s (check network/proxy settings): " + uri);
            } catch (HttpTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "image fetch timed out: " + uri);
            } catch (SSLException e) {
                throw new EngineException("E_HTTP", "TLS failure for " + uri + ": " + e.getMessage(), e);
            } catch (IOException e) {
                throw new EngineException("E_HTTP", "image fetch failed for " + uri + ": " + rootMessage(e), e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new EngineException("E_HTTP", "image fetch interrupted: " + uri, e);
            }
            int status = response.statusCode();
            rememberCookies(uri, response);
            String location = response.headers().firstValue("location").orElse(null);
            if (REDIRECT_STATUS.contains(status) && location != null && hops < 5) {
                closeQuietly(response.body());
                try {
                    uri = uri.resolve(location);
                } catch (IllegalArgumentException e) {
                    throw new EngineException("E_HTTP", "bad redirect location for " + uri + ": " + location);
                }
                hops++;
                continue;
            }
            if (status < 200 || status >= 300) {
                closeQuietly(response.body());
                throw new EngineException("E_HTTP", "image returned HTTP " + status + " for " + uri);
            }
            String contentType = response.headers().firstValue("content-type").orElse("");
            String declaredMime = contentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
            // Obvious non-image types are rejected before buffering; ambiguous ones are sniffed below.
            if (!declaredMime.startsWith("image/") && !likelyImageOrOpaque(declaredMime)) {
                closeQuietly(response.body());
                throw new EngineException("E_UNSUPPORTED",
                        "not an image (content-type: " + (contentType.isEmpty() ? "none" : contentType) + ")");
            }
            String mime = declaredMime;
            long declared = 0L;
            try {
                declared = Long.parseLong(response.headers().firstValue("content-length").orElse("0").trim());
            } catch (NumberFormatException ignored) {
                declared = 0L;
            }
            if (declared > maxBytes) {
                closeQuietly(response.body());
                throw new EngineException("E_TOO_LARGE",
                        "image is " + declared + " bytes, limit is " + maxBytes);
            }
            byte[] payload;
            try (InputStream in = response.body()) {
                payload = readCapped(in, maxBytes);
            } catch (BodyTooLarge e) {
                throw new EngineException("E_TOO_LARGE", "image exceeds " + maxBytes + " bytes: " + uri);
            } catch (HttpTimeoutException e) {
                throw new EngineException("E_TIMEOUT", "image body timed out: " + uri);
            } catch (IOException e) {
                throw new EngineException("E_HTTP", "cannot read image body: " + rootMessage(e), e);
            }
            if (!mime.startsWith("image/")) {
                // Some CDNs mislabel covers as octet-stream; the file signature still proves an image.
                String sniffed = sniffImageMime(payload);
                if (sniffed == null) {
                    throw new EngineException("E_UNSUPPORTED",
                            "not an image (content-type: "
                                    + (contentType.isEmpty() ? "none" : contentType)
                                    + ", " + payload.length + " bytes)");
                }
                System.err.println("[dawncomic] image.proxy sniffed " + sniffed
                        + " for mistyped content-type '" + contentType + "'");
                mime = sniffed;
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("dataUrl", "data:" + mime + ";base64," + Base64.getEncoder().encodeToString(payload));
            out.put("bytes", (long) payload.length);
            out.put("mime", mime);
            synchronized (imageCache) {
                imageCache.put(rawUrl, new LinkedHashMap<>(out));
            }
            System.err.println("[dawncomic] image.proxy " + uri + " -> " + payload.length + " bytes " + mime);
            return out;
        }
    }

    // ------------------------------------------------------------------ helpers

    private HttpRequest.Builder builderFor(URI uri, String method, byte[] body,
                                           Map<String, Object> headers, boolean useCookies, long timeoutMs)
            throws EngineException {
        HttpRequest.Builder builder = HttpRequest.newBuilder(uri).timeout(Duration.ofMillis(timeoutMs));
        boolean hasUa = false;
        boolean hasCookie = false;
        if (headers != null) {
            for (Map.Entry<String, Object> e : headers.entrySet()) {
                String name = e.getKey();
                if (name == null || name.trim().isEmpty() || e.getValue() == null) {
                    continue;
                }
                String value = String.valueOf(e.getValue());
                String lower = name.trim().toLowerCase(Locale.ROOT);
                if (RESTRICTED.contains(lower)) {
                    System.err.println("[dawncomic] skipped restricted header: " + name);
                    continue;
                }
                if ("user-agent".equals(lower)) {
                    hasUa = true;
                }
                if ("cookie".equals(lower)) {
                    hasCookie = true;
                }
                try {
                    builder.header(name.trim(), value);
                } catch (IllegalArgumentException rejected) {
                    System.err.println("[dawncomic] header rejected by client: " + name);
                }
            }
        }
        if (!hasUa) {
            try {
                builder.header("User-Agent", DEFAULT_UA);
            } catch (IllegalArgumentException rejected) {
                // Some JDKs restrict User-Agent; http.agent is set at startup as the fallback.
                System.err.println("[dawncomic] User-Agent header refused, relying on http.agent");
            }
        }
        if (useCookies && !hasCookie && cookies != null) {
            String cookie = cookies.cookieFor(uri.getHost());
            if (!cookie.isEmpty()) {
                builder.header("Cookie", cookie);
            }
        }
        HttpRequest.BodyPublisher publisher = (body == null || body.length == 0)
                ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofByteArray(body);
        builder.method(method, publisher);
        return builder;
    }

    private static byte[] bodyBytes(Map<String, Object> params) throws EngineException {
        String base64 = Json.str(params, "bodyBase64", "");
        if (!base64.isEmpty()) {
            try {
                return Base64.getDecoder().decode(base64.trim());
            } catch (IllegalArgumentException e) {
                throw EngineException.invalid("bodyBase64 is not valid base64");
            }
        }
        String body = Json.str(params, "body", "");
        return body.isEmpty() ? null : body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    private static URI parseHttpUri(String raw) throws EngineException {
        URI uri;
        try {
            uri = new URI(raw.trim());
        } catch (URISyntaxException e) {
            throw EngineException.invalid("malformed url: " + raw);
        }
        String scheme = uri.getScheme();
        if (scheme == null) {
            throw EngineException.invalid("url must be absolute and http(s): " + raw);
        }
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) {
            throw new EngineException("E_UNSUPPORTED", "unsupported scheme: " + scheme);
        }
        if (uri.getHost() == null || uri.getHost().isEmpty()) {
            throw EngineException.invalid("url has no host: " + raw);
        }
        return uri;
    }

    private void rememberCookies(URI uri, HttpResponse<?> response) {
        if (cookies == null) {
            return;
        }
        List<String> setCookie = response.headers().allValues("set-cookie");
        if (!setCookie.isEmpty()) {
            cookies.mergeSetCookie(uri.getHost(), setCookie);
        }
    }

    private static Map<String, Object> flatHeaders(HttpResponse<?> response) {
        Map<String, Object> out = new LinkedHashMap<>();
        response.headers().map().forEach((name, values) -> {
            String key = name.toLowerCase(Locale.ROOT);
            if ("set-cookie".equals(key)) {
                return; // never leak credentials into the page layer
            }
            out.put(key, String.join(", ", values));
        });
        return out;
    }

    private static String charsetOf(String contentType) {
        if (contentType == null) {
            return null;
        }
        String[] parts = contentType.split(";");
        for (int i = 1; i < parts.length; i++) {
            String part = parts[i].trim();
            int eq = part.indexOf('=');
            if (eq > 0 && "charset".equalsIgnoreCase(part.substring(0, eq).trim())) {
                return part.substring(eq + 1).trim().replace("\"", "");
            }
        }
        return null;
    }

    /** Signals that a streamed body exceeded the caller's cap. */
    private static final class BodyTooLarge extends Exception {
        private static final long serialVersionUID = 1L;
    }

    /**
     * Decides whether a non-{@code image/*} content type may still be a mislabelled image.
     *
     * @param mime lower-cased media type
     * @return true for empty or generic binary types that are worth sniffing
     */
    private static boolean likelyImageOrOpaque(String mime) {
        if (mime == null || mime.isEmpty()) {
            return true;
        }
        switch (mime) {
            case "application/octet-stream":
            case "binary/octet-stream":
            case "application/unknown":
            case "application/binary":
            case "application/download":
                return true;
            default:
                return false;
        }
    }

    /**
     * Identifies an image format from its leading bytes.
     *
     * @param data response body, at least a few bytes long
     * @return detected MIME type, or {@code null} when the payload is not a recognised image
     */
    private static String sniffImageMime(byte[] data) {
        if (data == null || data.length < 12) {
            return null;
        }
        int b0 = data[0] & 0xFF;
        int b1 = data[1] & 0xFF;
        int b2 = data[2] & 0xFF;
        int b3 = data[3] & 0xFF;
        if (b0 == 0x89 && b1 == 0x50 && b2 == 0x4E && b3 == 0x47) {
            return "image/png";
        }
        if (b0 == 0xFF && b1 == 0xD8 && b2 == 0xFF) {
            return "image/jpeg";
        }
        if (b0 == 0x47 && b1 == 0x49 && b2 == 0x46 && b3 == 0x38) {
            return "image/gif";
        }
        if (b0 == 0x42 && b1 == 0x4D) {
            return "image/bmp";
        }
        if (b0 == 0x00 && b1 == 0x00 && b2 == 0x01 && b3 == 0x00) {
            return "image/x-icon";
        }
        boolean riff = b0 == 0x52 && b1 == 0x49 && b2 == 0x46 && b3 == 0x46;
        boolean webp = (data[8] & 0xFF) == 0x57 && (data[9] & 0xFF) == 0x45
                && (data[10] & 0xFF) == 0x42 && (data[11] & 0xFF) == 0x50;
        if (riff && webp) {
            return "image/webp";
        }
        boolean ftyp = (data[4] & 0xFF) == 0x66 && (data[5] & 0xFF) == 0x74
                && (data[6] & 0xFF) == 0x79 && (data[7] & 0xFF) == 0x70;
        if (ftyp && data.length >= 16) {
            String brand = new String(data, 8, 4, java.nio.charset.StandardCharsets.US_ASCII);
            if ("avif".equals(brand) || "avis".equals(brand)) {
                return "image/avif";
            }
            if ("heic".equals(brand) || "heix".equals(brand) || "mif1".equals(brand)) {
                return "image/heic";
            }
        }
        return null;
    }

    private static byte[] readCapped(InputStream in, long cap) throws IOException, BodyTooLarge {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(8192);
        byte[] chunk = new byte[16 * 1024];
        long total = 0L;
        int read;
        while ((read = in.read(chunk)) > 0) {
            total += read;
            if (total > cap) {
                throw new BodyTooLarge();
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    private static long copyToFile(InputStream in, Path target) throws IOException {
        byte[] chunk = new byte[64 * 1024];
        long total = 0L;
        try (OutputStream out = Files.newOutputStream(target)) {
            int read;
            while ((read = in.read(chunk)) > 0) {
                out.write(chunk, 0, read);
                total += read;
            }
        }
        return total;
    }

    /**
     * Computes the SHA-256 of a file by streaming it.
     *
     * @param path file to hash
     * @return lowercase hex digest
     * @throws EngineException when the file cannot be read
     */
    static String sha256Of(Path path) throws EngineException {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new EngineException("E_UNSUPPORTED", "SHA-256 unavailable", e);
        }
        try (InputStream in = Files.newInputStream(path)) {
            byte[] chunk = new byte[64 * 1024];
            int read;
            while ((read = in.read(chunk)) > 0) {
                digest.update(chunk, 0, read);
            }
        } catch (IOException e) {
            throw EngineException.io("cannot hash " + path + ": " + e.getMessage(), e);
        }
        byte[] sum = digest.digest();
        StringBuilder hex = new StringBuilder(sum.length * 2);
        for (byte b : sum) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return hex.toString();
    }

    private static void closeQuietly(InputStream in) {
        if (in == null) {
            return;
        }
        try {
            in.close();
        } catch (IOException ignored) {
            // nothing useful to do while discarding a redirect body
        }
    }

    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException ignored) {
            // best effort cleanup of partial downloads
        }
    }

    private static String rootMessage(Throwable t) {
        Throwable current = t;
        while (current.getCause() != null && current.getCause() != current) {
            current = current.getCause();
        }
        String message = current.getMessage();
        return message == null ? current.getClass().getSimpleName() : message;
    }

    /**
     * Lists the entries currently held in the in-memory image cache.
     *
     * @return cached URLs in least-recently-used order
     */
    List<String> cachedImageUrls() {
        synchronized (imageCache) {
            return new ArrayList<>(imageCache.keySet());
        }
    }
}
