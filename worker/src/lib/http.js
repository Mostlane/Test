// Shared HTTP helpers: JSON responses + CORS.

export function corsHeaders(env, request) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map(s => s.trim());
  const origin = request.headers.get("Origin") || "";
  const allowOrigin =
    allowed.includes("*") ? "*" :
    allowed.includes(origin) ? origin : allowed[0] || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Device-Id",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function json(data, init = {}, env, request) {
  return new Response(JSON.stringify(data), {
    status: init.status || 200,
    headers: {
      "Content-Type": "application/json",
      // API JSON is per-user and often personal: never let the browser (or a
      // proxy) keep a copy on disk. The pages fetch live every time anyway.
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(env, request),
      ...(init.headers || {}),
    },
  });
}

export function error(message, status = 400, env, request) {
  return json({ ok: false, error: message }, { status }, env, request);
}

export function preflight(env, request) {
  return new Response(null, { status: 204, headers: corsHeaders(env, request) });
}
