import { HttpsProxyAgent } from "https-proxy-agent";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { child } from "./logger";

const log = child("proxy");

/**
 * Optional outbound-proxy support. A no-op for the common case (no proxy env),
 * but lets the bot run behind a corporate/forward proxy — and inside sandboxes
 * where all egress must traverse an HTTP CONNECT proxy. Both the WebSocket
 * (`ws` via https-proxy-agent) and `fetch` (undici global dispatcher) honour it.
 *
 * Controlled by the standard env vars: HTTPS_PROXY / https_proxy and
 * NO_PROXY / no_proxy. Neither library reads these automatically, so we wire it.
 */

function proxyEnv(): string | null {
  return process.env.HTTPS_PROXY || process.env.https_proxy || null;
}

function noProxyEnv(): string {
  return process.env.NO_PROXY || process.env.no_proxy || "";
}

/** True if `host` matches an entry in the NO_PROXY list (suffix/exact match). */
function isBypassed(host: string): boolean {
  const list = noProxyEnv()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of list) {
    if (entry === "*") return true;
    const e = entry.replace(/^\./, "");
    if (host === e || host.endsWith(`.${e}`)) return true;
  }
  return false;
}

/** Proxy URL to use for `targetUrl`, or null if direct/ bypassed. */
export function proxyForUrl(targetUrl: string): string | null {
  const proxy = proxyEnv();
  if (!proxy) return null;
  try {
    const host = new URL(targetUrl).hostname;
    if (isBypassed(host)) return null;
  } catch {
    /* fall through and use the proxy */
  }
  return proxy;
}

/** An https-proxy-agent for `ws`, or undefined when no proxy applies. */
export function wsProxyAgent(targetUrl: string): HttpsProxyAgent<string> | undefined {
  const proxy = proxyForUrl(targetUrl);
  return proxy ? new HttpsProxyAgent(proxy) : undefined;
}

let fetchProxyInstalled = false;

/** Route global `fetch` (undici) through the proxy, once, if one is configured. */
export function installFetchProxy(): void {
  if (fetchProxyInstalled) return;
  const proxy = proxyEnv();
  if (!proxy) return;
  setGlobalDispatcher(new ProxyAgent({ uri: proxy }));
  fetchProxyInstalled = true;
  log.info({ proxy: redact(proxy) }, "fetch routed through proxy");
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return url;
  }
}
