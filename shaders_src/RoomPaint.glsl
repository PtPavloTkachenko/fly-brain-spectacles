// RoomPaint - the intro room scan grid painted with the baked room colours (11.09 Pavlo: "paint the
// world mesh during the scan, the grid in
// the colours of the scan, not blue"). World-space neon grid lines + fill on the tracked world mesh,
// PAINTED with the room colours as they bake (WorldColorBake voxel-hash texture, same texel mapping
// as VisionHash): baked voxels show their real colour, unbaked ones a dim neutral wire. `dissolve` burns
// the mesh away cell by cell with a glowing edge when the scan ends. ASCII only.

input_texture_2d colors;
input_color4 tint = vec4(0.25, 0.9, 1.0, 1.0);
input_float intensity = 1.0;
input_float dissolve = 0.0;
// The tint input is `tint`, never `color`: the Spectacles cross-compiler rejects a uniform named `color`.
input_float cell = 12.0;
input_float voxel = 8.0;

output_vec4 vertexColor;

float hash3(vec3 p) {
    // 12.09 shader audit: with `+ 33.33` the intermediate reaches ~2e4, and mediump on the glasses
    // has a spacing of ~16 there - `fract` then returns steps instead of noise and the dissolve
    // degrades into bands. Same hash, constants small enough to keep everything under ~500.
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 3.33);
    return fract((p.x + p.y) * p.z * 7.0);
}

void main() {
    mat4 mw = system.getMatrixWorld();
    vec3 wp = (mw * vec4(system.getSurfacePositionObjectSpace(), 1.0)).xyz;
    vec3 n = normalize((mw * vec4(system.getSurfaceNormalObjectSpace(), 0.0)).xyz);

    float c = cell;
    if (c < 1.0) c = 1.0;
    vec3 f = fract(wp / c);
    vec3 d = min(f, 1.0 - f);
    vec3 cut = step(0.3, 1.0 - abs(n));
    vec3 l = (1.0 - smoothstep(0.0, 0.045, d)) * cut;
    float line = max(l.x, max(l.y, l.z));

    // baked room colour of this 8 cm voxel (alpha = baked)
    float vs = voxel;
    if (vs < 1.0) vs = 1.0;
    vec3 iv = floor(wp / vs);
    float u = mod(iv.x, 64.0) + 64.0 * mod(iv.z, 4.0);
    float v = mod(iv.y, 32.0) + 32.0 * mod(floor(iv.z / 4.0), 8.0);
    vec4 bc = colors.sample(vec2((u + 0.5) / 256.0, (v + 0.5) / 256.0));
    // 11.09 "the grid in the colours of the scan, not blue": unbaked cells stay a dim neutral wire,
    // baked ones light up in their real colour (lines + fill); the fly tint only burns the dissolve edge
    // additive display: a dark room colour is invisible, so keep the hue and lift it to full
    // brightness (11.09 device: 5.5k cells baked but 'the mesh has no colour')
    float peak = max(bc.r, max(bc.g, bc.b));
    if (peak < 0.08) peak = 0.08;
    vec3 hue = bc.rgb / peak;
    vec3 paint = mix(vec3(0.5, 0.55, 0.6), hue, bc.a);
    float fill = 0.03 + 0.8 * bc.a;
    float lineK = 0.3 + 0.7 * bc.a;

    float r = hash3(floor(wp / (c * 0.5)) + 17.0);
    float alive = step(dissolve, r);
    float edge = (1.0 - smoothstep(0.0, 0.1, r - dissolve)) * alive * smoothstep(0.0, 0.05, dissolve);

    vec3 col = (paint * (line * lineK + fill) + tint.rgb * edge * 1.6) * alive * intensity;
    vertexColor = vec4(col, 1.0);
}
