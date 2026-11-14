package app.dawncomic;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Standalone smoke test for {@link Json}.
 *
 * <p>Run directly, no framework required:</p>
 * <pre>
 *   javac -d out $(find engine/java -name '*.java')
 *   java -cp out app.dawncomic.JsonTest
 * </pre>
 * <p>Success prints one {@code JsonTest: N checks passed} line on stderr; any failure throws and the
 * process exits non-zero so {@code test.py} can gate on it.</p>
 */
public final class JsonTest {

    private static int checks;

    private JsonTest() {
    }

    /**
     * Runs the checks.
     *
     * @param args ignored
     */
    public static void main(String[] args) {
        parsesScalars();
        parsesStructures();
        rejectsMalformed();
        roundTripsEscapes();
        writesNumbersSafely();
        System.err.println("JsonTest: " + checks + " checks passed");
    }

    private static void parsesScalars() {
        eq(Long.valueOf(42L), Json.parse("42"), "int");
        eq(Long.valueOf(-7L), Json.parse("-7"), "negative int");
        eq(Double.valueOf(1.5), Json.parse("1.5"), "double");
        eq(Double.valueOf(-2.5E3), Json.parse("-2.5e3"), "exponent");
        eq(Boolean.TRUE, Json.parse("true"), "true");
        eq(Boolean.FALSE, Json.parse("false"), "false");
        eq(null, Json.parse("null"), "null");
        eq("\u4e2d\u6587", Json.parse("\"\u4e2d\u6587\""), "raw utf8 string");
    }

    private static void parsesStructures() {
        Map<String, Object> obj = Json.asObject(Json.parse("{\"a\":[1,2,{\"b\":null}],\"c\":\"d\"}"));
        eq("d", obj.get("c"), "object member");
        List<Object> list = Json.asArray(obj.get("a"));
        eq(3, list.size(), "array size");
        eq(Long.valueOf(2L), list.get(1), "array element");
        eq(null, Json.asObject(list.get(2)).get("b"), "nested null");

        Map<String, Object> params = Json.asObject(Json.parse("  {\" method \" : \"x\" }\n"));
        eq("x", Json.str(params, " method ", "?"), "key with spaces");
        eq("?", Json.str(params, "missing", "?"), "missing key fallback");
        eq(true, Json.bool(params, "flag", true), "bool fallback");
        eq(5L, Json.num(params, "n", 5L, 0L, 10L), "num fallback");
    }

    private static void rejectsMalformed() {
        fails("{", "unterminated object");
        fails("{\"a\":1} trailing", "trailing data");
        fails("[1,]", "trailing comma");
        fails("\"unterminated", "unterminated string");
        fails("{\"a\" 1}", "missing colon");
    }

    private static void roundTripsEscapes() {
        String tricky = "quote\" back\\slash\ttab\nnewline\rreturn\b\f\u0001 control \u4e2d\u6587 emoji \uD83D\uDE00";
        String encoded = Json.stringify(tricky);
        eq(tricky, Json.parse(encoded), "escape round trip");
        eq("{\"k\":\"v\"}", Json.stringify(sortedMap("k", "v")), "map writing");
    }

    private static void writesNumbersSafely() {
        eq("null", Json.stringify(Double.NaN), "NaN becomes null");
        eq("null", Json.stringify(Double.POSITIVE_INFINITY), "Infinity becomes null");
        eq("null", Json.stringify(Double.NEGATIVE_INFINITY), "-Infinity becomes null");
        eq("12", Json.stringify(Long.valueOf(12L)), "long writing");
        eq("1.5", Json.stringify(Double.valueOf(1.5)), "double writing");
        eq("[1,2,3]", Json.stringify(asList(1L, 2L, 3L)), "array writing");
    }

    private static Map<String, Object> sortedMap(String k, String v) {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put(k, v);
        return map;
    }

    private static List<Object> asList(Object... values) {
        List<Object> out = new ArrayList<>();
        for (Object v : values) {
            out.add(v);
        }
        return out;
    }

    private static void eq(Object expected, Object actual, String what) {
        checks++;
        boolean same = expected == null ? actual == null : expected.equals(actual);
        if (!same) {
            throw new AssertionError("JsonTest failed [" + what + "]: expected <" + expected + "> got <"
                    + actual + ">");
        }
    }

    private static void fails(String text, String what) {
        checks++;
        try {
            Json.parse(text);
        } catch (IllegalArgumentException expected) {
            return;
        }
        throw new AssertionError("JsonTest failed [" + what + "]: expected rejection of " + text);
    }
}
