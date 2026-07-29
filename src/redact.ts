// Redactor for opt-in content inspection. Every byte read from the observed
// tree passes through redact() before it is displayed anywhere.

const TOKEN_RULES: Array<[RegExp, string]> = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, "anthropic-key"],
  [/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, "github-token"],
  [/github_pat_[A-Za-z0-9_]{20,}/g, "github-pat"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "jwt"],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g, "bearer-token"],
  [/\bAKIA[A-Z0-9]{16}\b/g, "aws-access-key-id"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "slack-token"],
];

// "some_api_key": "value"  /  "authToken": "value"  (JSON-ish fields)
const JSON_FIELD_RE =
  /("[^"]*(?:token|key|secret|password|passwd|credential|auth)[^"]*"\s*:\s*")((?:[^"\\]|\\.){4,})(")/gi;

// FOO_TOKEN=value style (shell snapshots, env dumps)
const ENV_FIELD_RE =
  /\b([A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z_]*)(\s*=\s*)(\S+)/g;

// Long opaque runs: hex >= 32 chars, base64-ish >= 48 chars. Over-redaction is
// the acceptable failure mode here.
const HEX_RUN = /\b[a-fA-F0-9]{32,}\b/g;
const B64_RUN = /\b[A-Za-z0-9+/]{48,}={0,2}\b/g;

export function redact(text: string): string {
  let out = text;
  out = out.replace(JSON_FIELD_RE, (_m, pre, _val, post) => `${pre}[REDACTED:field]${post}`);
  out = out.replace(ENV_FIELD_RE, (_m, name, eq) => `${name}${eq}[REDACTED:env]`);
  for (const [re, tag] of TOKEN_RULES) out = out.replace(re, `[REDACTED:${tag}]`);
  out = out.replace(HEX_RUN, (m) => `[REDACTED:hex${m.length}]`);
  out = out.replace(B64_RUN, (m) => `[REDACTED:b64x${m.length}]`);
  return out;
}
