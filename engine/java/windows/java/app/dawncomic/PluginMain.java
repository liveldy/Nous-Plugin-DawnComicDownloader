package app.dawncomic;

import java.io.BufferedOutputStream;
import java.io.BufferedReader;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;

/**
 * Host entry point for the Windows JVM module.
 *
 * <p>The host starts one worker per account/plugin and writes UTF-8 request lines to stdin; each
 * line is answered with exactly one JSON line on stdout. Everything else — including stray
 * {@code System.out} writes from libraries — is redirected to stderr so the ABI stream stays clean.
 * The process exits normally when stdin reaches EOF.</p>
 */
public final class PluginMain {

    private static final int EXIT_ABI_SETUP_FAILED = 2;

    private PluginMain() {
    }

    /**
     * Starts the engine and runs the synchronous request loop.
     *
     * @param args ignored
     */
    public static void main(String[] args) {
        PrintStream abiOut;
        try {
            // Unbuffered flush per line keeps the host's request/response pairing deterministic.
            abiOut = new PrintStream(new BufferedOutputStream(new FileOutputStream(FileDescriptor.out), 16 * 1024),
                    false, StandardCharsets.UTF_8);
        } catch (RuntimeException e) {
            System.err.println("[dawncomic] cannot open stdout: " + e);
            System.exit(EXIT_ABI_SETUP_FAILED);
            return;
        }

        // Fallback for JDKs that refuse a User-Agent header on HttpClient.
        System.setProperty("http.agent", HttpService.defaultUserAgent());
        // Any accidental stdout writer (logging, JDK warnings) must not corrupt the ABI stream.
        System.setOut(System.err);

        Engine engine;
        try {
            engine = Engine.bootstrap();
        } catch (IOException | RuntimeException e) {
            System.err.println("[dawncomic] fatal startup error: " + e);
            e.printStackTrace(System.err);
            System.exit(EXIT_ABI_SETUP_FAILED);
            return;
        }

        try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                if (line.isBlank()) continue; // the host may close with an empty write; it is not a request
                String response = engine.handle(line);
                abiOut.print(response);
                abiOut.print('\n');
                abiOut.flush();
            }
        } catch (IOException e) {
            System.err.println("[dawncomic] stdin failed: " + e);
        } finally {
            abiOut.flush();
        }
        System.err.println("[dawncomic] EOF, exiting; " + engine.describe());
    }
}
