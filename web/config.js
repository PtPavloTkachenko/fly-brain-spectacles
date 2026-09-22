/**
 * ONE Supabase config for the whole page.
 *
 * The room behind the PIN, the fly's memory and the brain-versions table all live in the SAME
 * Supabase project, so its ref and anon key are written down exactly once — here. `web/release.sh`
 * rewrites the three values below when it builds `web/site/`, so a deployed page needs no URL
 * parameters and the person who opens it types nothing but the PIN.
 *
 * The anon key is public by design: it ships inside the lens and inside this page, and the tables it
 * can touch are guarded by the RLS policies in DEPLOY.md §1b/§1c. The service-role key never appears
 * anywhere near this file.
 *
 * Order of precedence: a URL parameter (?sb= / ?sbkey= / ?relay= / ?key=) > these constants > what
 * this browser used last > the LAN relay next to an http page. When these constants name a project
 * the PIN gate shows no relay field at all; the ROOM chip (R) can still override it for a session.
 */
export const SB = {
  ref: "",     // the <ref> of https://<ref>.<host>                  (release.sh: SB_REF / --sb)
  host: "snapcloud.dev", // the project's domain (this one is a Snap Cloud project; supabase.co for a Supabase one) (release.sh: SB_HOST / --host)
  anon: "",    // the anon public key                                (release.sh: SB_ANON / --key)
  relay: "",   // a relay that is NOT Supabase (web/relay.py on a LAN); empty = derive from `ref`
};

/** the project's base URL (REST, auth, storage hang off it) */
/** the build stamp: release.sh writes the commit here; asset() appends it so a rebuilt .bin is a new URL
 *  (the deployed assets are cached for a year, see _headers) */
export const BUILD = "";
export const asset = (p) => (BUILD ? p + "?v=" + BUILD : p);
export const sbBase = (ref, host) => (ref ? `https://${ref}.${host || SB.host || "supabase.co"}` : "");
/** the Realtime websocket of a project ref — the one URL both the lens and the page must agree on */
export const sbRealtime = (ref, host) => (SB.relay ? SB.relay : ref ? `wss://${ref}.${host || SB.host || "supabase.co"}/realtime/v1/websocket` : "");
