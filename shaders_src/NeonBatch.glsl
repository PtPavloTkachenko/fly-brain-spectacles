// NeonBatch - many NeonQuads in ONE draw call (11.09 perf pass). Same look as NeonQuad, but the
// per-quad parameters come per vertex: uv0 = quad-local 0..1, uv1 = (r, g), uv2 = (b, intensity),
// uv3 = (glowMode, fadeX). glowMode 0 = bar with soft top/bottom edges, 1 = radial disc. ASCII only.

input_float alpha = 1.0;
input_float gain = 1.0;

output_vec4 vertexColor;

void main() {
    vec2 uv = system.getSurfaceUVCoord0();
    vec2 rg = system.getSurfaceUVCoord1();
    vec2 bi = system.getSurfaceUVCoord2();
    vec2 gf = system.getSurfaceUVCoord3();
    vec2 c = uv * 2.0 - 1.0;
    float radial = 1.0 - length(c);
    if (radial < 0.0) radial = 0.0;
    radial = radial * radial;
    float bar = smoothstep(0.0, 0.3, uv.y) * smoothstep(1.0, 0.7, uv.y);
    float shape = mix(bar, radial, gf.x);
    shape = shape * mix(1.0, uv.x, gf.y);
    // 12.09 shader audit: `gain` and `alpha` are written once to 1.0 and never again, so they were
    // two multiplies per pixel across every board quad and eye dot, forever. The per-vertex
    // intensity (bi.y) already does that job; UIBatch no longer writes either uniform.
    vec3 col = vec3(rg.x, rg.y, bi.x) * bi.y * shape;
    vertexColor = vec4(col, shape);
}
