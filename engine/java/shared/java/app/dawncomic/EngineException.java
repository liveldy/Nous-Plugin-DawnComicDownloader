package app.dawncomic;

/**
 * Carries a stable error code plus a human readable message across the plugin ABI.
 *
 * <p>The host receives {@code {"error":"E_CODE: message"}}; the code prefix is parsed by the
 * page bundle so messages may change freely without breaking callers.</p>
 */
public final class EngineException extends Exception {

    private static final long serialVersionUID = 1L;

    private final String code;

    /**
     * Creates a coded failure.
     *
     * @param code stable code such as {@code E_INVALID_PARAMS}
     * @param message human readable detail
     */
    public EngineException(String code, String message) {
        super(message == null ? code : message);
        this.code = code;
    }

    /**
     * Creates a coded failure wrapping another cause.
     *
     * @param code stable code such as {@code E_IO}
     * @param message human readable detail
     * @param cause underlying failure
     */
    public EngineException(String code, String message, Throwable cause) {
        super(message == null ? code : message, cause);
        this.code = code;
    }

    /**
     * Returns the stable error code.
     *
     * @return one of the {@code E_*} codes documented by the module
     */
    public String code() {
        return code;
    }

    /**
     * Renders the ABI error string.
     *
     * @return {@code "E_CODE: message"}
     */
    public String toAbiString() {
        return code + ": " + getMessage();
    }

    /** Convenience factory for parameter errors. */
    static EngineException invalid(String message) {
        return new EngineException("E_INVALID_PARAMS", message);
    }

    /** Convenience factory for I/O failures. */
    static EngineException io(String message, Throwable cause) {
        return new EngineException("E_IO", message, cause);
    }

    /** Convenience factory for access violations. */
    static EngineException denied(String message) {
        return new EngineException("E_DENIED", message);
    }
}
