package app.dawncomic;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Dependency-free JSON reader/writer for the DawnComicDownloader native engine.
 *
 * <p>Value mapping: object &rarr; {@link Map}&lt;String,Object&gt;, array &rarr; {@link List}&lt;Object&gt;,
 * string &rarr; {@link String}, integer &rarr; {@link Long}, fractional/exponent &rarr; {@link Double},
 * {@code true}/{@code false} &rarr; {@link Boolean}, {@code null} &rarr; {@code null}.</p>
 *
 * <p>The writer emits UTF-8 friendly text (non-ASCII characters are passed through unescaped),
 * escapes quotes, backslashes and control characters, and never emits {@code NaN} or
 * {@code Infinity} (such doubles are written as {@code null}).</p>
 */
public final class Json {

    /** Guard against pathological nesting in untrusted input. */
    private static final int MAX_DEPTH = 200;

    private final String src;
    private final int len;
    private int pos;

    private Json(String src) {
        this.src = src;
        this.len = src.length();
    }

    // ------------------------------------------------------------------ parsing

    /**
     * Parses one JSON value from {@code text}.
     *
     * @param text JSON document
     * @return the parsed value, using the mapping documented on this class
     * @throws IllegalArgumentException when the text is not a single well-formed JSON value
     */
    public static Object parse(String text) {
        if (text == null) {
            throw new IllegalArgumentException("json: null input");
        }
        Json p = new Json(text);
        p.skipWhitespace();
        Object value = p.readValue(0);
        p.skipWhitespace();
        if (p.pos != p.len) {
            throw new IllegalArgumentException("json: trailing data at offset " + p.pos);
        }
        return value;
    }

    /**
     * Convenience accessor used for untyped request payloads.
     *
     * @param value any value produced by {@link #parse(String)}
     * @return the value as a string-keyed map
     * @throws IllegalArgumentException when the value is not an object
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> asObject(Object value) {
        if (value instanceof Map<?, ?>) {
            return (Map<String, Object>) value;
        }
        throw new IllegalArgumentException("json: value is not an object");
    }

    /**
     * Convenience accessor used for untyped request payloads.
     *
     * @param value any value produced by {@link #parse(String)}
     * @return the value as a list
     * @throws IllegalArgumentException when the value is not an array
     */
    @SuppressWarnings("unchecked")
    public static List<Object> asArray(Object value) {
        if (value instanceof List<?>) {
            return (List<Object>) value;
        }
        throw new IllegalArgumentException("json: value is not an array");
    }

    private Object readValue(int depth) {
        if (depth > MAX_DEPTH) {
            throw new IllegalArgumentException("json: nesting too deep");
        }
        if (pos >= len) {
            throw new IllegalArgumentException("json: unexpected end of input");
        }
        char c = src.charAt(pos);
        switch (c) {
            case '{':
                return readObject(depth);
            case '[':
                return readArray(depth);
            case '"':
                return readString();
            case 't':
                expectLiteral("true");
                return Boolean.TRUE;
            case 'f':
                expectLiteral("false");
                return Boolean.FALSE;
            case 'n':
                expectLiteral("null");
                return null;
            default:
                if (c == '-' || (c >= '0' && c <= '9')) {
                    return readNumber();
                }
                throw new IllegalArgumentException("json: unexpected character '" + c + "' at offset " + pos);
        }
    }

    private Map<String, Object> readObject(int depth) {
        Map<String, Object> out = new LinkedHashMap<>();
        pos++; // {
        skipWhitespace();
        if (pos < len && src.charAt(pos) == '}') {
            pos++;
            return out;
        }
        while (true) {
            skipWhitespace();
            if (pos >= len || src.charAt(pos) != '"') {
                throw new IllegalArgumentException("json: expected object key at offset " + pos);
            }
            String key = readString();
            skipWhitespace();
            if (pos >= len || src.charAt(pos) != ':') {
                throw new IllegalArgumentException("json: expected ':' at offset " + pos);
            }
            pos++;
            skipWhitespace();
            out.put(key, readValue(depth + 1));
            skipWhitespace();
            if (pos >= len) {
                throw new IllegalArgumentException("json: unterminated object");
            }
            char c = src.charAt(pos++);
            if (c == '}') {
                return out;
            }
            if (c != ',') {
                throw new IllegalArgumentException("json: expected ',' or '}' at offset " + (pos - 1));
            }
        }
    }

    private List<Object> readArray(int depth) {
        List<Object> out = new ArrayList<>();
        pos++; // [
        skipWhitespace();
        if (pos < len && src.charAt(pos) == ']') {
            pos++;
            return out;
        }
        while (true) {
            skipWhitespace();
            out.add(readValue(depth + 1));
            skipWhitespace();
            if (pos >= len) {
                throw new IllegalArgumentException("json: unterminated array");
            }
            char c = src.charAt(pos++);
            if (c == ']') {
                return out;
            }
            if (c != ',') {
                throw new IllegalArgumentException("json: expected ',' or ']' at offset " + (pos - 1));
            }
        }
    }

    private String readString() {
        pos++; // opening quote
        StringBuilder sb = new StringBuilder();
        while (true) {
            if (pos >= len) {
                throw new IllegalArgumentException("json: unterminated string");
            }
            char c = src.charAt(pos++);
            if (c == '"') {
                return sb.toString();
            }
            if (c != '\\') {
                if (c < 0x20) {
                    throw new IllegalArgumentException("json: raw control character in string");
                }
                sb.append(c);
                continue;
            }
            if (pos >= len) {
                throw new IllegalArgumentException("json: unterminated escape");
            }
            char esc = src.charAt(pos++);
            switch (esc) {
                case '"':
                    sb.append('"');
                    break;
                case '\\':
                    sb.append('\\');
                    break;
                case '/':
                    sb.append('/');
                    break;
                case 'b':
                    sb.append('\b');
                    break;
                case 'f':
                    sb.append('\f');
                    break;
                case 'n':
                    sb.append('\n');
                    break;
                case 'r':
                    sb.append('\r');
                    break;
                case 't':
                    sb.append('\t');
                    break;
                case 'u':
                    if (pos + 4 > len) {
                        throw new IllegalArgumentException("json: truncated \\u escape");
                    }
                    String hex = src.substring(pos, pos + 4);
                    pos += 4;
                    try {
                        sb.append((char) Integer.parseInt(hex, 16));
                    } catch (NumberFormatException e) {
                        throw new IllegalArgumentException("json: bad \\u escape '" + hex + "'");
                    }
                    break;
                default:
                    throw new IllegalArgumentException("json: bad escape '\\" + esc + "'");
            }
        }
    }

    private Object readNumber() {
        int start = pos;
        if (pos < len && src.charAt(pos) == '-') {
            pos++;
        }
        while (pos < len && isNumberChar(src.charAt(pos))) {
            pos++;
        }
        String raw = src.substring(start, pos);
        if (raw.isEmpty() || "-".equals(raw)) {
            throw new IllegalArgumentException("json: bad number at offset " + start);
        }
        boolean integral = raw.indexOf('.') < 0 && raw.indexOf('e') < 0 && raw.indexOf('E') < 0;
        if (integral) {
            try {
                return Long.valueOf(Long.parseLong(raw));
            } catch (NumberFormatException ignored) {
                // falls through to double for out-of-range integers
            }
        }
        try {
            return Double.valueOf(Double.parseDouble(raw));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("json: bad number '" + raw + "'");
        }
    }

    private static boolean isNumberChar(char c) {
        return (c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-';
    }

    private void expectLiteral(String literal) {
        if (!src.startsWith(literal, pos)) {
            throw new IllegalArgumentException("json: expected '" + literal + "' at offset " + pos);
        }
        pos += literal.length();
    }

    private void skipWhitespace() {
        while (pos < len) {
            char c = src.charAt(pos);
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') {
                pos++;
            } else {
                return;
            }
        }
    }

    // ------------------------------------------------------------------ writing

    /**
     * Serializes a value using the mapping documented on this class.
     *
     * @param value value to serialize; unknown types are written as their {@code toString()} form
     * @return compact JSON text
     */
    public static String stringify(Object value) {
        StringBuilder sb = new StringBuilder(512);
        write(sb, value);
        return sb.toString();
    }

    /**
     * Appends the JSON form of {@code value} to {@code out}.
     *
     * @param out destination buffer
     * @param value value to serialize
     */
    public static void write(StringBuilder out, Object value) {
        if (value == null) {
            out.append("null");
        } else if (value instanceof String) {
            writeString(out, (String) value);
        } else if (value instanceof Boolean) {
            out.append(((Boolean) value).booleanValue() ? "true" : "false");
        } else if (value instanceof Long || value instanceof Integer || value instanceof Short
                || value instanceof Byte) {
            out.append(((Number) value).longValue());
        } else if (value instanceof Number) {
            writeDouble(out, ((Number) value).doubleValue());
        } else if (value instanceof Map<?, ?>) {
            writeMap(out, (Map<?, ?>) value);
        } else if (value instanceof Iterable<?>) {
            writeIterable(out, (Iterable<?>) value);
        } else if (value instanceof Object[]) {
            writeArray(out, (Object[]) value);
        } else {
            writeString(out, String.valueOf(value));
        }
    }

    private static void writeMap(StringBuilder out, Map<?, ?> map) {
        out.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> e : map.entrySet()) {
            if (!first) {
                out.append(',');
            }
            first = false;
            writeString(out, String.valueOf(e.getKey()));
            out.append(':');
            write(out, e.getValue());
        }
        out.append('}');
    }

    private static void writeIterable(StringBuilder out, Iterable<?> values) {
        out.append('[');
        boolean first = true;
        for (Object v : values) {
            if (!first) {
                out.append(',');
            }
            first = false;
            write(out, v);
        }
        out.append(']');
    }

    private static void writeArray(StringBuilder out, Object[] values) {
        out.append('[');
        for (int i = 0; i < values.length; i++) {
            if (i > 0) {
                out.append(',');
            }
            write(out, values[i]);
        }
        out.append(']');
    }

    private static void writeDouble(StringBuilder out, double d) {
        if (Double.isNaN(d) || Double.isInfinite(d)) {
            out.append("null");
            return;
        }
        if (d == Math.rint(d) && Math.abs(d) < 1.0e15) {
            out.append((long) d).append(".0");
            return;
        }
        out.append(Double.toString(d));
    }

    private static void writeString(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\b':
                    out.append("\\b");
                    break;
                case '\f':
                    out.append("\\f");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        out.append("\\u");
                        String hex = Integer.toHexString(c);
                        for (int pad = hex.length(); pad < 4; pad++) {
                            out.append('0');
                        }
                        out.append(hex);
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }

    // ---------------------------------------------------------------- read helpers

    /**
     * Reads a string member, returning {@code fallback} when absent or of another type.
     *
     * @param map source object
     * @param key member name
     * @param fallback value to use when missing
     * @return the string member or the fallback
     */
    public static String str(Map<String, Object> map, String key, String fallback) {
        Object v = map == null ? null : map.get(key);
        return v instanceof String ? (String) v : fallback;
    }

    /**
     * Reads an integral number member, clamping it to the supplied range.
     *
     * @param map source object
     * @param key member name
     * @param fallback value to use when missing or not numeric
     * @param min lower clamp
     * @param max upper clamp
     * @return the clamped value
     */
    public static long num(Map<String, Object> map, String key, long fallback, long min, long max) {
        Object v = map == null ? null : map.get(key);
        long out = fallback;
        if (v instanceof Number) {
            out = ((Number) v).longValue();
        } else if (v instanceof String) {
            try {
                out = Long.parseLong(((String) v).trim());
            } catch (NumberFormatException ignored) {
                out = fallback;
            }
        }
        if (out < min) {
            return min;
        }
        if (out > max) {
            return max;
        }
        return out;
    }

    /**
     * Reads a boolean member.
     *
     * @param map source object
     * @param key member name
     * @param fallback value to use when missing or not boolean
     * @return the boolean member or the fallback
     */
    public static boolean bool(Map<String, Object> map, String key, boolean fallback) {
        Object v = map == null ? null : map.get(key);
        if (v instanceof Boolean) {
            return ((Boolean) v).booleanValue();
        }
        if (v instanceof String) {
            return "true".equalsIgnoreCase((String) v);
        }
        return fallback;
    }

    /**
     * Reads an object member.
     *
     * @param map source object
     * @param key member name
     * @return the nested object, or {@code null} when absent or not an object
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> obj(Map<String, Object> map, String key) {
        Object v = map == null ? null : map.get(key);
        return v instanceof Map<?, ?> ? (Map<String, Object>) v : null;
    }

    private Json() {
        throw new AssertionError("no instances");
    }
}
