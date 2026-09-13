// WorldScanGrid - light neon visualisation of the world mesh during the intro room scan.
// Pixel-only (no position output): world-space grid lines on every surface plus a faint fill;
// `dissolve` 0..1 burns the mesh away cell by cell with a glowing edge when the scan ends.
// ASCII only.

input_color4 color = vec4(0.25, 0.9, 1.0, 1.0);
input_float intensity = 1.0;
input_float dissolve = 0.0;
input_float cell = 12.0;

output_vec4 vertexColor;

float hash3(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

void main() {
    mat4 mw = system.getMatrixWorld();
    vec3 wp = (mw * vec4(system.getSurfacePositionObjectSpace(), 1.0)).xyz;
    vec3 n = normalize((mw * vec4(system.getSurfaceNormalObjectSpace(), 0.0)).xyz);

    float c = cell;
    if (c < 1.0) c = 1.0;
    vec3 f = fract(wp / c);
    vec3 d = min(f, 1.0 - f);
    // only planes that cut the surface draw lines (a floor must not light up as a whole)
    vec3 cut = step(0.3, 1.0 - abs(n));
    vec3 l = (1.0 - smoothstep(0.0, 0.045, d)) * cut;
    float line = max(l.x, max(l.y, l.z));

    // dissolve: each half-cell has a random threshold; alive above it, glowing just above it
    float r = hash3(floor(wp / (c * 0.5)) + 17.0);
    float alive = step(dissolve, r);
    float edge = (1.0 - smoothstep(0.0, 0.1, r - dissolve)) * alive * smoothstep(0.0, 0.05, dissolve);

    vec3 col = color.rgb * (line * 0.9 + 0.06 + edge * 1.6) * alive * intensity;
    vertexColor = vec4(col, 1.0);
}
