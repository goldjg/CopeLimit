declare const base64Decode: (input: string) => string;
declare const base64Encode: (input: string | object) => string;

interface EnvironmentVariables {
    delete: (key: string) => void;
    get: (key: string) => string | undefined;
    has: (key: string) => boolean;
    set: (key: string, value: string) => void;
    toObject: () => Record<string, string>;
}
/**
 * Returns a cross-runtime interface for handling environment variables. It
 * uses the `Netlify.env` global if available, otherwise looks for `Deno.env`
 * and `process.env`.
 */
declare const getEnvironment: () => EnvironmentVariables;

export { type EnvironmentVariables, base64Decode, base64Encode, getEnvironment };
