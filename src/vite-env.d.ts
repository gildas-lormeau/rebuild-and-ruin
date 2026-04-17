// Just enough Vite typing for our runtime: `?url` asset imports give back a
// URL string at build time. We deliberately do NOT pull in full `vite/client`
// types — they declare `import.meta.env: ImportMetaEnv` as non-optional, which
// turns our defensive `import.meta.env?.DEV` guards (needed at runtime in the
// Deno test harness where `import.meta.env` is actually undefined) into false-
// positive useless-guard lint hits.

declare module "*?url" {
  const url: string;
  export default url;
}
