export const PORT = Number(process.env.PORT ?? 8787);
export const TICK_MS = Number(process.env.TICK_MS ?? 15000);
export const JOURNAL = process.env.JOURNAL ?? "journey.jsonl";

const CONTACT = process.env.CONTACT ?? "https://github.com/local/wanderer";
if (/example\.(com|org|net)/.test(CONTACT)) {
  throw new Error("CONTACT must be a real contact address; OSM services block example.com outright.");
}
export const USER_AGENT = `wanderer/1.0 (+${CONTACT})`;

export const OVERPASS = (
  process.env.OVERPASS_URL ??
  "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter"
).split(",");

// Which highway classes the walker may use, and therefore what counts as a fork
// worth stopping for. The default is "real forks": the classified network that
// links villages, so bends and side streets do not interrupt the walk. Append
// |residential|living_street|service|track to stop at every junction instead —
// faithful to "turns wherever there is more than one road", but in a town that
// is a decision every thirty metres and the walk never leaves it.
export const ROADS =
  process.env.ROADS ?? "motorway|trunk|primary|secondary|tertiary|unclassified|road";

export const STEP_KM = Number(process.env.STEP_KM ?? 2.5);
export const SPOKE_MAX_KM = Number(process.env.SPOKE_MAX_KM ?? 0.45);
export const NETWORK_RADIUS_M = Number(process.env.NETWORK_RADIUS_M ?? 3000);
export const KM_PER_DAY = 40;
