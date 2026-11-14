package app.dawncomic;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Filesystem surface for the DawnComicDownloader engine: allowed-root policy plus the {@code fs.*} and
 * {@code file.*} methods.
 *
 * <p>Writes are restricted to the plugin data directory (and, additively, to directories the page
 * authorised through {@code fs.allowRoot}). Read-only helpers do not apply that restriction because
 * the user may legitimately ask the engine to open a file picked elsewhere on disk.</p>
 */
public final class FileService {

    private final Path dataRoot;
    private final Path engineHome;
    private final Set<Path> allowedRoots = new LinkedHashSet<>();

    /**
     * Creates the service.
     *
     * @param dataRoot private per-account data directory from {@code nous.plugin.root}
     * @param engineHome module directory from {@code nous.engine.home}
     */
    public FileService(Path dataRoot, Path engineHome) {
        this.dataRoot = canonical(dataRoot.toAbsolutePath().normalize());
        this.engineHome = engineHome == null ? null : canonical(engineHome.toAbsolutePath().normalize());
    }

    /**
     * Returns the plugin data directory.
     *
     * @return absolute canonical data root
     */
    public Path dataRoot() {
        return dataRoot;
    }

    /**
     * Returns the module directory, when the host provided one.
     *
     * @return absolute canonical engine home, or {@code null}
     */
    public Path engineHome() {
        return engineHome;
    }

    // ------------------------------------------------------------------ roots

    /**
     * Registers a user-chosen directory as an additional write root for this process.
     *
     * @param raw absolute directory path
     * @return the resolved directory
     * @throws EngineException {@code E_INVALID_PARAMS} when the path is relative or not a directory
     */
    public Path allowRoot(String raw) throws EngineException {
        if (raw == null || raw.trim().isEmpty()) {
            throw EngineException.invalid("path is required");
        }
        Path path = parsePath(raw);
        if (!path.isAbsolute()) {
            throw EngineException.invalid("allowRoot requires an absolute path: " + raw);
        }
        if (Files.exists(path) && !Files.isDirectory(path)) {
            throw EngineException.invalid("allowRoot path is not a directory: " + path);
        }
        try {
            Files.createDirectories(path);
        } catch (IOException | RuntimeException e) {
            throw EngineException.io("cannot create allowed root " + path + ": " + e.getMessage(), e);
        }
        Path real = canonical(path);
        synchronized (allowedRoots) {
            allowedRoots.add(real);
        }
        System.err.println("[dawncomic] allowed root registered: " + real);
        return real;
    }

    /**
     * Resolves a path that is about to be written.
     *
     * @param raw caller supplied path
     * @return canonical absolute path inside the data root or an allowed root
     * @throws EngineException {@code E_DENIED} when the target escapes every permitted root
     */
    public Path resolveWritable(String raw) throws EngineException {
        if (raw == null || raw.trim().isEmpty()) {
            throw EngineException.invalid("path is required");
        }
        Path target = canonical(parsePath(raw));
        if (isInsideAnyRoot(target)) {
            return target;
        }
        throw EngineException.denied("path outside allowed roots: " + target);
    }

    private boolean isInsideAnyRoot(Path target) {
        if (target.startsWith(dataRoot) && !target.equals(dataRoot)) {
            return true;
        }
        synchronized (allowedRoots) {
            for (Path root : allowedRoots) {
                if (target.startsWith(root) && !target.equals(root)) {
                    return true;
                }
            }
        }
        return false;
    }

    private boolean isRootItselfOrParent(Path target) {
        if (target.equals(dataRoot) || target.startsWith(dataRoot)) {
            return true;
        }
        synchronized (allowedRoots) {
            for (Path root : allowedRoots) {
                if (root.equals(target) || root.startsWith(target)) {
                    return true;
                }
            }
        }
        return false;
    }

    private Path parsePath(String raw) throws EngineException {
        try {
            return Paths.get(raw.trim());
        } catch (RuntimeException e) {
            throw EngineException.invalid("malformed path: " + raw);
        }
    }

    /**
     * Normalises a path against the filesystem so symlinks and {@code ..} cannot escape a root.
     *
     * @param path input path
     * @return canonical absolute path
     */
    static Path canonical(Path path) {
        Path abs = path.toAbsolutePath().normalize();
        ArrayDeque<Path> missingTail = new ArrayDeque<>();
        Path probe = abs;
        while (probe != null && !Files.exists(probe)) {
            Path name = probe.getFileName();
            if (name != null) {
                missingTail.push(name);
            }
            probe = probe.getParent();
        }
        if (probe == null) {
            return abs;
        }
        Path real;
        try {
            real = probe.toRealPath();
        } catch (IOException e) {
            return abs;
        }
        for (Path part : missingTail) {
            real = real.resolve(part);
        }
        return real.normalize();
    }

    // ------------------------------------------------------------------ fs.list

    /**
     * Lists a directory.
     *
     * @param raw directory path
     * @return {@code {path, entries:[{name,path,dir,bytes,mtime}]}} sorted by name
     * @throws EngineException when the directory cannot be read
     */
    public Map<String, Object> list(String raw) throws EngineException {
        if (raw == null || raw.trim().isEmpty()) {
            throw EngineException.invalid("path is required");
        }
        Path dir = canonical(parsePath(raw));
        if (!Files.exists(dir)) {
            throw new EngineException("E_IO", "directory does not exist: " + dir);
        }
        if (!Files.isDirectory(dir)) {
            throw new EngineException("E_IO", "not a directory: " + dir);
        }
        List<Map<String, Object>> entries = new ArrayList<>();
        try (java.util.stream.Stream<Path> stream = Files.list(dir)) {
            List<Path> children = new ArrayList<>();
            stream.forEach(children::add);
            children.sort(Comparator.comparing(p -> p.getFileName().toString().toLowerCase(Locale.ROOT)));
            for (Path child : children) {
                Map<String, Object> entry = new LinkedHashMap<>();
                boolean isDir = Files.isDirectory(child);
                long bytes = 0L;
                long mtime = 0L;
                try {
                    BasicFileAttributes attrs = Files.readAttributes(child, BasicFileAttributes.class);
                    mtime = attrs.lastModifiedTime().toMillis();
                    bytes = isDir ? 0L : attrs.size();
                } catch (IOException ignored) {
                    // unreadable child: keep zeroes rather than failing the whole listing
                }
                entry.put("name", child.getFileName().toString());
                entry.put("path", child.toAbsolutePath().toString());
                entry.put("dir", isDir);
                entry.put("bytes", bytes);
                entry.put("mtime", mtime);
                entries.add(entry);
            }
        } catch (IOException e) {
            throw EngineException.io("cannot list " + dir + ": " + e.getMessage(), e);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", dir.toString());
        out.put("entries", entries);
        return out;
    }

    // ------------------------------------------------------------------ fs.stat

    /**
     * Stats a path without failing when it is missing.
     *
     * @param raw path to inspect
     * @return {@code {exists,dir,bytes,mtime}}
     * @throws EngineException when the path is malformed
     */
    public Map<String, Object> stat(String raw) throws EngineException {
        if (raw == null || raw.trim().isEmpty()) {
            throw EngineException.invalid("path is required");
        }
        Path path = canonical(parsePath(raw));
        Map<String, Object> out = new LinkedHashMap<>();
        boolean exists = Files.exists(path);
        boolean dir = exists && Files.isDirectory(path);
        long bytes = 0L;
        long mtime = 0L;
        if (exists) {
            try {
                BasicFileAttributes attrs = Files.readAttributes(path, BasicFileAttributes.class);
                mtime = attrs.lastModifiedTime().toMillis();
                bytes = dir ? 0L : attrs.size();
            } catch (IOException e) {
                throw EngineException.io("cannot stat " + path + ": " + e.getMessage(), e);
            }
        }
        out.put("exists", exists);
        out.put("dir", dir);
        out.put("bytes", bytes);
        out.put("mtime", mtime);
        return out;
    }

    // ------------------------------------------------------------------ fs.mkdirs

    /**
     * Creates a directory tree inside the permitted roots.
     *
     * @param raw directory path
     * @return {@code {path, created}} where {@code created} reports a newly created directory
     * @throws EngineException {@code E_DENIED} when outside the roots
     */
    public Map<String, Object> mkdirs(String raw) throws EngineException {
        Path dir = resolveWritable(raw);
        boolean existed = Files.isDirectory(dir);
        try {
            Files.createDirectories(dir);
        } catch (IOException | RuntimeException e) {
            throw EngineException.io("cannot create directory " + dir + ": " + e.getMessage(), e);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("path", dir.toString());
        out.put("created", !existed);
        return out;
    }

    // ------------------------------------------------------------------ fs.delete

    /**
     * Recursively deletes a path inside the permitted roots.
     *
     * @param raw file or directory path
     * @return {@code {deleted, files}} with the number of regular files removed
     * @throws EngineException {@code E_DENIED} for roots themselves or their ancestors
     */
    public Map<String, Object> delete(String raw) throws EngineException {
        Path target = resolveWritable(raw);
        if (isRootItselfOrParent(target)) {
            throw EngineException.denied("refusing to delete a root or an ancestor of a root: " + target);
        }
        if (!Files.exists(target)) {
            Map<String, Object> missing = new LinkedHashMap<>();
            missing.put("deleted", false);
            missing.put("files", 0L);
            return missing;
        }
        AtomicLong files = new AtomicLong();
        try {
            Files.walkFileTree(target, new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                    Files.deleteIfExists(file);
                    if (attrs.isRegularFile()) {
                        files.incrementAndGet();
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(Path dir, IOException error) throws IOException {
                    if (error != null) {
                        throw error;
                    }
                    Files.deleteIfExists(dir);
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            throw EngineException.io("cannot delete " + target + ": " + e.getMessage(), e);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("deleted", true);
        out.put("files", files.get());
        return out;
    }

    // -------------------------------------------------------------- file.readBase64

    /**
     * Reads a file as base64 for uploads such as reverse-image search.
     *
     * @param raw file path
     * @param maxBytes upper bound; larger files raise {@code E_TOO_LARGE}
     * @return {@code {base64, bytes, mime}}
     * @throws EngineException when the file cannot be read or exceeds the bound
     */
    public Map<String, Object> readBase64(String raw, long maxBytes) throws EngineException {
        if (raw == null || raw.trim().isEmpty()) {
            throw EngineException.invalid("path is required");
        }
        Path path = canonical(parsePath(raw));
        if (!Files.isRegularFile(path)) {
            throw new EngineException("E_IO", "file does not exist: " + path);
        }
        long size;
        try {
            size = Files.size(path);
        } catch (IOException e) {
            throw EngineException.io("cannot stat " + path + ": " + e.getMessage(), e);
        }
        if (size > maxBytes) {
            throw new EngineException("E_TOO_LARGE",
                    "file is " + size + " bytes, limit is " + maxBytes);
        }
        byte[] data;
        try {
            data = Files.readAllBytes(path);
        } catch (IOException | OutOfMemoryError e) {
            throw EngineException.io("cannot read " + path + ": " + e.getMessage(), e);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("base64", Base64.getEncoder().encodeToString(data));
        out.put("bytes", (long) data.length);
        out.put("mime", mimeOf(path.getFileName().toString()));
        return out;
    }

    // ------------------------------------------------------------ system.openFolder

    /**
     * Opens a folder in the platform file manager without invoking a shell.
     *
     * @param raw folder path
     * @return {@code {opened:true}}
     * @throws EngineException {@code E_UNSUPPORTED} off Windows, {@code E_IO} when it cannot start
     */
    public Map<String, Object> openFolder(String raw) throws EngineException {
        if (raw == null || raw.trim().isEmpty()) {
            throw EngineException.invalid("path is required");
        }
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        if (!os.contains("win")) {
            throw new EngineException("E_UNSUPPORTED", "openFolder is Windows-only on this module");
        }
        if (raw.indexOf('"') >= 0) {
            throw EngineException.invalid("path must not contain a double quote");
        }
        Path path = canonical(parsePath(raw));
        if (!Files.exists(path)) {
            throw new EngineException("E_IO", "folder does not exist: " + path);
        }
        try {
            // ProcessBuilder passes the path as a single argv element: no shell interpolation.
            new ProcessBuilder("explorer.exe", path.toString()).start();
        } catch (IOException e) {
            throw EngineException.io("cannot start explorer.exe: " + e.getMessage(), e);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("opened", true);
        return out;
    }

    // ------------------------------------------------------------------ mime

    private static final Map<String, String> MIME = new LinkedHashMap<>();

    static {
        MIME.put("png", "image/png");
        MIME.put("jpg", "image/jpeg");
        MIME.put("jpeg", "image/jpeg");
        MIME.put("jfif", "image/jpeg");
        MIME.put("gif", "image/gif");
        MIME.put("webp", "image/webp");
        MIME.put("avif", "image/avif");
        MIME.put("bmp", "image/bmp");
        MIME.put("ico", "image/x-icon");
        MIME.put("svg", "image/svg+xml");
        MIME.put("mp4", "video/mp4");
        MIME.put("webm", "video/webm");
        MIME.put("json", "application/json");
        MIME.put("txt", "text/plain");
        MIME.put("html", "text/html");
        MIME.put("htm", "text/html");
        MIME.put("css", "text/css");
        MIME.put("js", "text/javascript");
        MIME.put("pdf", "application/pdf");
        MIME.put("zip", "application/zip");
    }

    /**
     * Guesses a MIME type from a file name.
     *
     * @param name file name or path fragment
     * @return known MIME type, or {@code application/octet-stream}
     */
    public static String mimeOf(String name) {
        if (name != null) {
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
                String mime = MIME.get(ext);
                if (mime != null) {
                    return mime;
                }
            }
        }
        return "application/octet-stream";
    }

    /**
     * Encodes bytes as UTF-8 text using the supplied charset name when possible.
     *
     * @param data raw bytes
     * @param charsetName charset from {@code Content-Type}, may be null
     * @return decoded text
     */
    static String decode(byte[] data, String charsetName) {
        if (charsetName != null && !charsetName.trim().isEmpty()) {
            try {
                return new String(data, java.nio.charset.Charset.forName(charsetName.trim()));
            } catch (RuntimeException ignored) {
                // unknown charset: fall back to UTF-8
            }
        }
        return new String(data, StandardCharsets.UTF_8);
    }
}
