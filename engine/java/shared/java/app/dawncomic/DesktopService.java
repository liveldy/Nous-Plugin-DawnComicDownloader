package app.dawncomic;

import java.awt.GraphicsEnvironment;
import java.io.File;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.atomic.AtomicReference;
import javax.swing.JFileChooser;
import javax.swing.SwingUtilities;
import javax.swing.UIManager;
import javax.swing.filechooser.FileSystemView;

/**
 * Desktop-only helpers that need AWT: a native folder picker so the page can offer
 * "browse…" next to the download directory field instead of asking the user to type a
 * path.
 *
 * <p>The dialog is modal to a null owner and runs on the event dispatch thread. The
 * engine answers one request at a time, so blocking here only delays that one request;
 * the page gives it a generous timeout and always keeps its own directory browser as a
 * fallback for headless sessions.</p>
 */
public final class DesktopService {

    private static final long serialVersionUID = 1L;

    /** Creates the service; stateless, one instance per engine. */
    public DesktopService() {
    }

    /**
     * Shows the system folder chooser.
     *
     * @param title     dialog title; falls back to a Chinese/English pair
     * @param startPath directory the chooser opens in, may be null
     * @return {@code {path}} where path is null when the user cancels
     * @throws EngineException {@code E_UNSUPPORTED} in a headless session, {@code E_IO} if AWT fails
     */
    public Map<String, Object> chooseFolder(String title, String startPath) throws EngineException {
        if (GraphicsEnvironment.isHeadless()) {
            throw new EngineException("E_UNSUPPORTED", "no desktop session for a folder dialog");
        }
        final File start = startDirectory(startPath);
        final String caption = (title == null || title.trim().isEmpty()) ? "选择下载目录" : title.trim();

        Callable<File> open = () -> {
            try {
                UIManager.setLookAndFeel(UIManager.getSystemLookAndFeelClassName());
            } catch (Exception ignored) {
                // keep the cross-platform look; the dialog still works
            }
            JFileChooser chooser = new JFileChooser(start);
            chooser.setDialogTitle(caption);
            chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
            chooser.setAcceptAllFileFilterUsed(false);
            chooser.setMultiSelectionEnabled(false);
            if (start != null) {
                chooser.setCurrentDirectory(start);
            }
            int result = chooser.showDialog(null, "选择");
            return result == JFileChooser.APPROVE_OPTION ? chooser.getSelectedFile() : null;
        };

        AtomicReference<File> picked = new AtomicReference<>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        try {
            SwingUtilities.invokeAndWait(() -> {
                try {
                    picked.set(open.call());
                } catch (Exception e) {
                    failure.set(e);
                }
            });
        } catch (Exception e) {
            throw EngineException.io("folder dialog failed: " + e.getMessage(), e);
        }
        if (failure.get() != null) {
            throw EngineException.io("folder dialog failed: " + failure.get().getMessage(), failure.get());
        }

        Map<String, Object> out = new LinkedHashMap<>();
        File file = picked.get();
        out.put("path", file == null ? null : file.getAbsolutePath());
        return out;
    }

    /** Resolves a usable starting folder without throwing on odd input. */
    private static File startDirectory(String raw) {
        if (raw != null && !raw.trim().isEmpty()) {
            File candidate = new File(raw.trim());
            if (candidate.isDirectory()) {
                return candidate;
            }
            File parent = candidate.getParentFile();
            if (parent != null && parent.isDirectory()) {
                return parent;
            }
        }
        try {
            File home = FileSystemView.getFileSystemView().getHomeDirectory();
            if (home != null && home.isDirectory()) {
                return home;
            }
        } catch (Exception ignored) {
            // fall through to the drives
        }
        File[] roots = File.listRoots();
        return roots != null && roots.length > 0 ? roots[0] : null;
    }
}
