// Device-safe rename (11.09): the Spectacles cross-compiler rejects a uniform named `color`
// ('color' : redefinition, no code generated) -> the input is `tint`. ASCII only.
// NeonGlow - one shader for the status board bars/tabs, the glow under the selected fly
// and its flight trail. Unit quad UVs: glowMode 0 = bar with soft top/bottom edges,
// glowMode 1 = radial glow disc. fadeX fades along uv.x (trail tail). ASCII only.

input_color4 tint = vec4(0.2, 1.0, 0.45, 1.0);
input_float intensity = 1.0;
input_float glowMode = 0.0;
input_float fadeX = 0.0;
input_float alpha = 1.0;

output_vec4 vertexColor;

void main() {
    vec2 uv = system.getSurfaceUVCoord0();
    vec2 c = uv * 2.0 - 1.0;
    float radial = 1.0 - length(c);
    if (radial < 0.0) radial = 0.0;
    radial = radial * radial;
    float bar = smoothstep(0.0, 0.3, uv.y) * smoothstep(1.0, 0.7, uv.y);
    float shape = mix(bar, radial, glowMode);
    if (glowMode > 1.5) shape = 1.0; // 2 = solid fill (plates, 15.09)
    shape = shape * mix(1.0, uv.x, fadeX);
    vec3 col = tint.rgb * intensity * shape;
    vertexColor = vec4(col, shape * alpha);
}
