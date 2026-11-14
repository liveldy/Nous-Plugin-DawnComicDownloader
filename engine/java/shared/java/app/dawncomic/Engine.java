package app.dawncomic;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Request dispatcher for the DawnComicDownloader native engine.
 *
 * <p>{@link #handle(String)} accepts exactly one JSON request line and returns exactly one JSON
 * response line; every failure is folded into {@code {"error":"E_CODE: message"}} so the host loop
 * never sees an exception. Logs go to stderr only.</p>
 */
public final class Engine {

    /** Module name reported by {@code engine.info}. */
    public static final String NAME = "dawn-engine";

    /** Module version reported by {@code engine.info}. */
    public static final String VERSION = "1.0.0";

    private final FileService files;
    private final CookieJar cookies;
    private final HttpService http;
    private final DesktopService desktop = new DesktopService();
    private final long startedAtMs;

    private Engine(FileService files, CookieJar cookies, HttpService http) {
        this.files = files;
        this.cookies = cookies;
        this.http = http;
        this.startedAtMs = System.currentTimeMillis();
    }

    /**
     * Builds the engine, resolving host-provided directories defensively.
     *
     * @return a ready engine instance
     * @throws IOException when the private data directory cannot be created
     */
    public static Engine bootstrap() throws IOException {
        Path dataRoot = resolveDataRoot();
        Files.createDirectories(dataRoot);
        Path engineHome = resolveEngineHome();
        FileService files = new FileService(dataRoot, engineHome);
        CookieJar cookies = new CookieJar(dataRoot.resolve("cookies.json"));
        HttpService http = new HttpService(files, cookies);
        System.err.println("[dawncomic] engine " + VERSION + " dataRoot=" + dataRoot
                + " engineHome=" + engineHome);
        return new Engine(files, cookies, http);
    }

    private static Path resolveDataRoot() {
        String configured = System.getProperty("nous.plugin.root");
        if (configured != null && !configured.trim().isEmpty()) {
            return Paths.get(configured.trim()).toAbsolutePath().normalize();
        }
        String home = System.getProperty("user.home");
        if (home == null || home.trim().isEmpty()) {
            home = ".";
        }
        return Paths.get(home, ".dawncomic").toAbsolutePath().normalize();
    }

    private static Path resolveEngineHome() {
        String configured = System.getProperty("nous.engine.home");
        if (configured != null && !configured.trim().isEmpty()) {
            return Paths.get(configured.trim()).toAbsolutePath().normalize();
        }
        try {
            Path codeSource = Paths.get(Engine.class.getProtectionDomain().getCodeSource()
                    .getLocation().toURI()).toAbsolutePath().normalize();
            if (java.nio.file.Files.isRegularFile(codeSource)) {
                Path parent = codeSource.getParent();
                if (parent != null && "app".equalsIgnoreCase(String.valueOf(parent.getFileName()))
                        && parent.getParent() != null) {
                    return parent.getParent();
                }
                return parent == null ? codeSource : parent;
            }
            return codeSource;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Handles one request line.
     *
     * @param line raw UTF-8 request line: {@code {"method":"...","params":{...}}}
     * @return one JSON object: {@code {"value":...}} or {@code {"error":"E_CODE: message"}}
     */
    public String handle(String line) {
        Map<String, Object> response = new LinkedHashMap<>();
        String method = "?";
        long started = System.nanoTime();
        try {
            if (line == null || line.trim().isEmpty()) {
                throw EngineException.invalid("empty request line");
            }
            Object parsed = Json.parse(line);
            Map<String, Object> request;
            try {
                request = Json.asObject(parsed);
            } catch (IllegalArgumentException e) {
                throw EngineException.invalid("request must be a JSON object");
            }
            method = Json.str(request, "method", "");
            if (method.isEmpty()) {
                throw EngineException.invalid("method is required");
            }
            Map<String, Object> params = Json.obj(request, "params");
            if (params == null) {
                Object rawParams = request.get("params");
                if (rawParams != null) {
                    throw EngineException.invalid("params must be a JSON object");
                }
                params = new LinkedHashMap<>();
            }
            response.put("value", dispatch(method, params));
        } catch (EngineException e) {
            response.clear();
            response.put("error", e.toAbiString());
        } catch (IllegalArgumentException e) {
            response.clear();
            response.put("error", "E_INVALID_PARAMS: " + e.getMessage());
        } catch (Throwable t) {
            System.err.println("[dawncomic] internal failure in " + method);
            t.printStackTrace(System.err);
            response.clear();
            response.put("error", "E_IO: internal error: " + t);
        }
        long elapsedMs = (System.nanoTime() - started) / 1_000_000L;
        Object value = response.get("value");
        if (response.containsKey("error")) {
            System.err.println("[dawncomic] " + method + " -> ERROR " + response.get("error")
                    + " (" + elapsedMs + " ms)");
        } else {
            System.err.println("[dawncomic] " + method + " -> ok (" + elapsedMs + " ms, value="
                    + (value == null ? "null" : value.getClass().getSimpleName()) + ")");
        }
        return Json.stringify(response);
    }

    private Object dispatch(String method, Map<String, Object> params) throws EngineException {
        switch (method) {
            case "engine.info":
                return info();
            case "engine.ping": {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("pong", true);
                out.put("uptimeMs", System.currentTimeMillis() - startedAtMs);
                return out;
            }
            case "http.request":
                return http.request(params);
            case "http.download":
                return http.download(params);
            case "fs.list":
                return files.list(Json.str(params, "path", ""));
            case "fs.stat":
                return files.stat(Json.str(params, "path", ""));
            case "fs.allowRoot": {
                Path resolved = files.allowRoot(Json.str(params, "path", ""));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("path", resolved.toString());
                return out;
            }
            case "fs.mkdirs":
                return files.mkdirs(Json.str(params, "path", ""));
            case "fs.delete":
                return files.delete(Json.str(params, "path", ""));
            case "file.writeBase64":
                return files.writeBase64(Json.str(params, "path", ""), Json.str(params, "base64", ""));
            case "file.readBase64":
                return files.readBase64(Json.str(params, "path", ""),
                        Json.num(params, "maxBytes", 8L * 1024 * 1024, 1L, 64L * 1024 * 1024));
            case "cookie.set": {
                String host = Json.str(params, "host", "");
                if (host.trim().isEmpty()) {
                    throw EngineException.invalid("host is required");
                }
                cookies.set(host, Json.str(params, "cookie", ""));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("ok", true);
                return out;
            }
            case "cookie.list": {
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("hosts", cookies.snapshot());
                return out;
            }
            case "cookie.clear": {
                cookies.clear(Json.str(params, "host", null));
                Map<String, Object> out = new LinkedHashMap<>();
                out.put("ok", true);
                return out;
            }
            case "net.probe":
                return http.probe(params);
            case "image.proxy":
                return http.imageProxy(params);
            case "system.chooseFolder":
                return desktop.chooseFolder(Json.str(params, "title", ""), Json.str(params, "path", ""));
            case "system.openFolder":
                return files.openFolder(Json.str(params, "path", ""));
            default:
                throw new EngineException("E_UNSUPPORTED", "unknown method: " + method);
        }
    }

    private Map<String, Object> info() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("name", NAME);
        out.put("version", VERSION);
        out.put("java", System.getProperty("java.version", "unknown"));
        String osName = System.getProperty("os.name", "unknown");
        String osArch = System.getProperty("os.arch", "unknown");
        out.put("os", osName + " " + osArch);
        out.put("dataRoot", files.dataRoot().toString());
        out.put("engineHome", files.engineHome() == null ? "" : files.engineHome().toString());
        out.put("userAgent", HttpService.defaultUserAgent());
        return out;
    }

    /**
     * Renders a short status line for stderr diagnostics at shutdown.
     *
     * @return human readable summary
     */
    String describe() {
        return NAME + " " + VERSION + " dataRoot=" + files.dataRoot()
                + " cookies=" + cookies.snapshot().size()
                + " images=" + http.cachedImageUrls().size()
                + " os=" + System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    }
}
