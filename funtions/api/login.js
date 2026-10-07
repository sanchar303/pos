// Cloudflare Pages Function: POST /api/login
// Verifies PIN / owner password on the server and returns a Firebase custom token.
const te = new TextEncoder();
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = o => b64u(te.encode(JSON.stringify(o)));
const out = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
const sha = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(s)))].map(b => b.toString(16).padStart(2, "0")).join("");
const same = (a, b) => {
  a = te.encode(String(a)); b = te.encode(String(b));
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a[i] || 0) ^ (b[i] || 0);
  return d === 0;
};
async function jwt(env, claims) {
  const pem = env.FB_PRIVATE_KEY.replace(/\\n/g, "\n").replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const head = enc({ alg: "RS256", typ: "JWT" }) + "." + enc(claims);
  return head + "." + b64u(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, te.encode(head)));
}

export async function onRequestPost({ request, env }) {
  try {
    const o = request.headers.get("Origin");
    if (o && o !== new URL(request.url).origin) return out({ error: "Forbidden" }, 403);
    let b;
    try { b = await request.json(); } catch (e) { return out({ error: "Bad request" }, 400); }

    const k = "f:" + (request.headers.get("CF-Connecting-IP") || "x");
    const n = env.RL ? +(await env.RL.get(k)) || 0 : 0;
    if (n >= 8) return out({ error: "Too many attempts. Try again in 10 minutes." }, 429);
    const bad = async m => { if (env.RL) await env.RL.put(k, String(n + 1), { expirationTtl: 600 }); return out({ error: m }, 401); };

    const now = Math.floor(Date.now() / 1000), email = env.FB_CLIENT_EMAIL;
    const token = (uid, claims) => jwt(env, {
      iss: email, sub: email, uid, claims, iat: now, exp: now + 3600,
      aud: "https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit"
    });

    if (b.mode === "hq") {
      const pw = String(b.password || "");
      const okHq = env.HQ_PASSWORD ? same(pw, env.HQ_PASSWORD) : !!env.HQ_HASH && same(await sha(pw), env.HQ_HASH);
      if (!okHq) return bad("Invalid owner password.");
      return out({ token: await token("hq", { role: "hq" }) });
    }

    const code = String(b.code || "").trim().toUpperCase(), pin = String(b.pin || "");
    const msg = "Invalid restaurant code or PIN.";
    if (!/^[A-Z0-9_-]{3,20}$/.test(code) || !pin || pin.length > 20) return bad(msg);

    const at = await (await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: await jwt(env, {
          iss: email, iat: now, exp: now + 3600, aud: "https://oauth2.googleapis.com/token",
          scope: "https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email"
        })
      })
    })).json();
    const r = await fetch(`${env.DB_URL.replace(/\/$/, "")}/8848/restaurants/${code}.json?access_token=${at.access_token}`);
    const t = r.ok ? await r.json() : null;
    if (!t) return bad(msg);

    if (t.managerPin && same(pin, t.managerPin))
      return out({ token: await token("mgr:" + code, { role: "manager", code }), role: "manager", code, name: "Manager" });
    const s = Object.entries(t.staffPins || {}).find(([, x]) => x && x.pin && same(pin, x.pin));
    if (s) return out({ token: await token(`stf:${code}:${s[0]}`, { role: "staff", code }), role: "staff", code, name: s[1].name });
    return bad(msg);
  } catch (e) {
    return out({ error: "Server error" }, 500);
  }
}