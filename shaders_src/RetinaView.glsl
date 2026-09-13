// RetinaView - the little panel on the board that shows WHAT THE BRAIN SEES (12.09 the user: "can we
// show the fly-eye render target the way its brain sees it, in a small corner near the brain?").
//
// Not the camera image: the texture is built from FlyVision.retina(i), the same 16x8 RGB array that
// is sent to the brain as its retina (mean brightness pinned, ADR 15). One texel per ommatidial
// block, sampled NEAREST so the blocks stay blocks - that coarseness IS the honest part.
//
// `eye` carries the retina, `tint` is the selected fly's colour, `gain` lifts it for the additive
// display, `grid` draws faint cell borders so it reads as a sensor, not a photo. ASCII only;
// no input named `color` (the Spectacles cross-compiler rejects it).

input_texture_2d eye;
input_color4 tint = vec4(0.86, 0.95, 1.0, 1.0);
input_float gain = 1.3;
input_float grid = 0.35;
input_float cells = 16.0;

output_vec4 vertexColor;

void main() {
    vec2 uv = system.getSurfaceUVCoord0();
    vec2 flipped = vec2(uv.x, 1.0 - uv.y); // LS flips V on import; the retina's first row is the top
    vec3 seen = eye.sample(flipped).rgb;

    // faint per-cell border: a thin dark line at each block edge
    float c = cells;
    if (c < 2.0) c = 2.0;
    vec2 f = fract(uv * vec2(c, c * 0.5));
    vec2 e = min(f, 1.0 - f);
    float line = 1.0 - smoothstep(0.0, 0.06, min(e.x, e.y));

    vec3 col = seen * gain * tint.rgb * (1.0 - grid * line);
    vertexColor = vec4(col, 1.0);
}
