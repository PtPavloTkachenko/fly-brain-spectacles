// VisionTint (was VisionColor; `texture` is a GLSL built-in -> renamed `blocky`) - the world mesh as the flies' eye cameras see it (FlyVision layer only).
// Colour baked per vertex from the scan camera frames (WorldColorBake): rgb packed into
// uv1 (r, g) + uv2.x (b). A faint world-space block pattern (+-`blocky`) gives a 32 px eye
// something to track for optic flow where the baked colour is flat. The mesh object has an
// identity transform, so object space == world space. ASCII only.

input_float gain = 1.0;
input_float blocky = 0.25;
input_float cell = 40.0;

output_vec4 vertexColor;

float hash3(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

void main() {
    vec2 rg = system.getSurfaceUVCoord1();
    float b = system.getSurfaceUVCoord2().x;
    vec3 wp = system.getSurfacePositionObjectSpace();
    float c = cell;
    if (c < 1.0) c = 1.0;
    float blocks = hash3(floor(wp / (c * 0.5)) + 5.0) * 2.0 - 1.0;
    vec3 col = vec3(rg.x, rg.y, b) * gain * (1.0 + blocky * blocks);
    vertexColor = vec4(col, 1.0);
}
