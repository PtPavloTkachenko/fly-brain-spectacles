// FlyHolo - neon rim-light hologram for the giant flies (pixel-only: skinning stays default).
// v2 (11.09 the user: "stronger, softer rim; paint them nicely"):
//  - two neon colours per fly: rimColor at the head -> bodyColor at the abdomen tip
//  - iridescent shift of that gradient with the viewing angle
//  - soft wide rim halo + thin hot edge, faint body fill, fine abdomen stripes, scan bands
// On the additive Spectacles display black is transparent, so this reads as a hologram.
// Body-only edits: replace the Code Node body only (ASCII only)

input_color4 rimColor = vec4(0.2, 1.0, 0.45, 1.0);
input_color4 bodyColor = vec4(1.0, 0.9, 0.2, 1.0);
input_float rimPower = 1.6;
input_float glow = 1.6;
input_float bodyGlow = 0.06;
input_float scanDensity = 0.8;
input_float scanSpeed = 3.0;
input_float scanAmount = 0.2;

output_vec4 vertexColor;

void main() {
    vec3 po = system.getSurfacePositionObjectSpace();
    mat4 world = system.getMatrixWorld();
    vec3 p = (world * vec4(po, 1.0)).xyz;
    vec3 n = normalize((world * vec4(system.getSurfaceNormalObjectSpace(), 0.0)).xyz);
    vec3 cam = system.getMatrixCamera()[3].xyz;
    vec3 v = normalize(cam - p);
    float facing = abs(dot(n, v));
    float edge = 1.0 - facing;

    // head (+x) -> abdomen tip (-x) gradient, shifted by viewing angle (iridescence)
    float g = (0.12 - po.x) / 0.36;
    g = g + 0.35 * edge;
    if (g < 0.0) g = 0.0;
    if (g > 1.0) g = 1.0;
    vec3 tint = mix(rimColor.rgb, bodyColor.rgb, g);

    float halo = pow(edge, rimPower);
    float hot = pow(edge, rimPower * 4.0) * 0.8;
    // 12.09 shader audit: getTimeElapsed grows without bound, and a mediump sin() argument in the
    // thousands quantises (at 10 min t*37 is ~22200, where the spacing is +-16) - the flicker and the
    // scan bands freeze or judder on device. Both time phases are wrapped into 0..2pi instead.
    float t = system.getTimeElapsed();
    float TAU = 6.2831853;
    float scanPhase = fract(t * scanSpeed / TAU) * TAU;
    float band = 0.5 + 0.5 * sin(p.y * scanDensity - scanPhase);
    float scan = smoothstep(0.85, 1.0, band) * scanAmount;
    float stripes = 0.0;
    if (po.x < -0.06) stripes = smoothstep(0.6, 1.0, 0.5 + 0.5 * sin(po.x * 140.0)) * 0.25;
    float flicker = 0.95 + 0.05 * sin(fract(t * 5.8887) * TAU); // 37 rad/s = 5.8887 Hz, phase wrapped

    float light = (halo + hot + scan + stripes * (0.3 + halo)) * glow * flicker;
    vec3 col = tint * (bodyGlow + light) + vec3(1.0, 1.0, 1.0) * hot * 0.35 * glow;
    float a = bodyGlow + halo + scan;
    if (a > 1.0) a = 1.0;
    vertexColor = vec4(col, a);
}
