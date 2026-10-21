// Reed-Solomon over GF(2^8) (primitive polynomial 0x11d, first consecutive root α^0).
// Systematic encoder plus an errors-and-erasures decoder (Berlekamp-Massey + Chien + Forney).

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a: number, b: number) => {
  if (b === 0) throw new Error('GF divide by zero');
  return a === 0 ? 0 : EXP[(LOG[a] + 255 - LOG[b]) % 255];
};
const pow = (a: number, n: number) => EXP[(((LOG[a] * n) % 255) + 255) % 255];
const inv = (a: number) => EXP[255 - LOG[a]];

// Polynomials are arrays of coefficients, highest degree first.
function polyMul(p: number[], q: number[]): number[] {
  const r = new Array(p.length + q.length - 1).fill(0);
  for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= mul(p[i], q[j]);
  return r;
}
function polyEval(p: number[], x: number): number {
  let y = p[0];
  for (let i = 1; i < p.length; i++) y = mul(y, x) ^ p[i];
  return y;
}
function polyAdd(p: number[], q: number[]): number[] {
  const n = Math.max(p.length, q.length);
  const r = new Array(n).fill(0);
  for (let i = 0; i < p.length; i++) r[i + n - p.length] = p[i];
  for (let i = 0; i < q.length; i++) r[i + n - q.length] ^= q[i];
  return r;
}
const polyScale = (p: number[], x: number) => p.map((c) => mul(c, x));

const generators = new Map<number, number[]>();
function generator(nsym: number): number[] {
  let g = generators.get(nsym);
  if (!g) {
    g = [1];
    for (let i = 0; i < nsym; i++) g = polyMul(g, [1, pow(2, i)]);
    generators.set(nsym, g);
  }
  return g;
}

/** Returns data followed by nsym parity bytes. data.length + nsym must be <= 255. */
export function rsEncode(data: Uint8Array, nsym: number): Uint8Array {
  if (data.length + nsym > 255) throw new Error('RS codeword too long');
  const gen = generator(nsym);
  const out = new Uint8Array(data.length + nsym);
  out.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = out[i];
    if (coef !== 0) for (let j = 1; j < gen.length; j++) out[i + j] ^= mul(gen[j], coef);
  }
  out.set(data);
  return out;
}

function syndromes(msg: Uint8Array, nsym: number): number[] {
  const s = new Array(nsym);
  const m = Array.from(msg);
  for (let i = 0; i < nsym; i++) s[i] = polyEval(m, pow(2, i));
  return s;
}

export interface RsResult {
  data: Uint8Array;
  corrected: number;
}

/**
 * Decodes a codeword. `erasures` are known-bad positions (indices into the codeword).
 * Corrects up to 2*errors + erasures <= nsym. Returns null when uncorrectable.
 */
export function rsDecode(codeword: Uint8Array, nsym: number, erasures: number[] = []): RsResult | null {
  const n = codeword.length;
  if (erasures.length > nsym) return null;
  const msg = Uint8Array.from(codeword);
  const synd = syndromes(msg, nsym);
  if (synd.every((s) => s === 0)) return { data: msg.slice(0, n - nsym), corrected: 0 };

  // Erasure locator Γ(x) = Π (1 + X_i x), X_i = α^(n-1-pos)
  let eraseLoc = [1];
  for (const pos of erasures) eraseLoc = polyMul(eraseLoc, [pow(2, n - 1 - pos), 1]);

  // Forney syndromes eliminate erasures so BM finds only the unknown errors.
  const fsynd = synd.slice();
  for (const pos of erasures) {
    const x = pow(2, n - 1 - pos);
    for (let j = 0; j < fsynd.length - 1; j++) fsynd[j] = mul(fsynd[j], x) ^ fsynd[j + 1];
  }
  fsynd.length = nsym - erasures.length;

  // Berlekamp-Massey on Forney syndromes (lowest degree first internally, converted at end).
  let errLoc = [1];
  let oldLoc = [1];
  for (let i = 0; i < fsynd.length; i++) {
    let delta = fsynd[i];
    for (let j = 1; j < errLoc.length; j++) delta ^= mul(errLoc[errLoc.length - 1 - j], fsynd[i - j]);
    oldLoc = [...oldLoc, 0];
    if (delta !== 0) {
      if (oldLoc.length > errLoc.length) {
        const newLoc = polyScale(oldLoc, delta);
        oldLoc = polyScale(errLoc, inv(delta));
        errLoc = newLoc;
      }
      errLoc = polyAdd(errLoc, polyScale(oldLoc, delta));
    }
  }
  while (errLoc.length && errLoc[0] === 0) errLoc.shift();
  const errCount = errLoc.length - 1;
  if (errCount * 2 + erasures.length > nsym) return null;

  // Chien search for error positions.
  const errPos: number[] = [];
  for (let i = 0; i < n; i++) {
    if (polyEval(errLoc, pow(2, 255 - (n - 1 - i))) === 0) errPos.push(i);
  }
  if (errPos.length !== errCount) return null;

  const positions = [...new Set([...erasures, ...errPos])];
  // Combined locator and evaluator, then Forney magnitudes.
  const coefPos = positions.map((p) => n - 1 - p);
  let loc = [1];
  for (const c of coefPos) loc = polyMul(loc, [pow(2, c), 1]);
  const syndRev = synd.slice().reverse();
  let omega = polyMul(syndRev, loc);
  omega = omega.slice(omega.length - nsym);

  const X = coefPos.map((c) => pow(2, c));
  for (let i = 0; i < X.length; i++) {
    const xiInv = inv(X[i]);
    let denom = 1;
    for (let j = 0; j < X.length; j++) if (j !== i) denom = mul(denom, 1 ^ mul(xiInv, X[j]));
    if (denom === 0) return null;
    const y = polyEval(omega, xiInv);
    msg[positions[i]] ^= div(y, denom);
  }
  if (!syndromes(msg, nsym).every((s) => s === 0)) return null;
  let corrected = 0;
  for (let i = 0; i < n; i++) if (msg[i] !== codeword[i]) corrected++;
  return { data: msg.slice(0, n - nsym), corrected };
}
