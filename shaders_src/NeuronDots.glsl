// NeuronDots (was BrainDots) - v3 of the brain hologram. The mesh object sits at the scene root with an
// identity transform, so object space == world space whatever the Object->World node does
// (gpu-particles recipe). TS feeds the placement: origin + axisX/Y/Z (world, scaled) map the
// unit neuron positions onto the board's holo stage; camRight/camUp + pointSize billboard
// every neuron in world space. uv1 = activity texel, uv2.x = superclass hue. ASCII only.

input_texture_2d activity;
input_color4 tint = vec4(0.2, 1.0, 0.45, 1.0);
input_float pointSize = 0.3;
input_float flash = 1.0;
input_float baseGlow = 0.12;
input_vec3 camRight = vec3(1.0, 0.0, 0.0);
input_vec3 camUp = vec3(0.0, 1.0, 0.0);
input_vec3 origin = vec3(0.0, 0.0, 0.0);
input_vec3 axisX = vec3(1.0, 0.0, 0.0);
input_vec3 axisY = vec3(0.0, 1.0, 0.0);
input_vec3 axisZ = vec3(0.0, 0.0, 1.0);

output_vec3 transformedPosition;
output_vec4 vertexColor;

vec3 hueRgb(float h) {
    vec3 k = vec3(1.0, 0.6666667, 0.3333333);
    vec3 p = abs(fract(vec3(h, h, h) + k) * 6.0 - 3.0);
    return clamp(p - 1.0, 0.0, 1.0);
}

void main() {
    vec3 u = system.getSurfacePositionObjectSpace();
    vec2 corner = system.getSurfaceUVCoord0() - 0.5;
    vec3 centre = origin + axisX * u.x + axisY * u.y + axisZ * u.z;

    // activity texel: r = spike level (decays), g = hovered branch, b = dimmed (another branch hovered)
    vec4 tx = activity.sample(system.getSurfaceUVCoord1());
    // uv2.y = 1 on a COMMAND cell (DNa02, the escape DNs, DNpe007, MN9, PPL101): 1 to 8 neurons each
    // out of the 16,000 drawn, so at the shared dot size they were invisible and the hologram never
    // showed the status (12.09 the user). They are drawn as beacons; a hovered branch grows again.
    // Only the command branches grow on hover: a region row is thousands of neurons, and growing
    // those blew the whole lobe into one white cloud (12.09 the user: "avoid such strong blowouts").
    float cmd = system.getSurfaceUVCoord2().y;
    float hl = cmd * tx.g;
    // 12.09 shader audit: `grow` must NOT depend on the activity sample. This body is compiled into
    // both stages, so anything the vertex output touches keeps its inputs alive there - through `hl`
    // the texture was fetched 4 x 16,000 = 64,000 extra times per frame in the VERTEX stage alone.
    // Size now comes from the command flag only; the hover still brightens the branch.
    float grow = 1.0 + 2.5 * cmd;
    float beacon = 1.0 + 1.2 * cmd + 2.5 * hl;
    transformedPosition = centre + (camRight * corner.x + camUp * corner.y) * pointSize * grow;
    float d = length(corner) * 2.0;
    float core = 1.0 - smoothstep(0.0, 0.32, d);
    float halo = exp(-d * d * 5.0);
    float hot = tx.r * flash;
    // hover isolation (11.09 the user): never brighten the chosen branch - dim everything else
    // silhouette always visible (11.09 the user): dimmed branches keep half their resting glow,
    // only their spikes drop to 10 %
    float keepRest = 1.0 - 0.5 * tx.b;
    float keepHot = 1.0 - 0.9 * tx.b;
    // the whole brain wears the selected fly's colour (11.09 the user); spikes = the same hue, whiter
    vec3 rest = mix(vec3(0.5, 0.62, 0.78), tint.rgb, 0.8 + 0.1 * tx.g);
    rest = mix(rest, hueRgb(system.getSurfaceUVCoord2().x), 0.08);
    vec3 spark = mix(tint.rgb, vec3(1.0, 1.0, 1.0), 0.45);
    // resting floor lives in each dot's CORE (11.09 the user: "minimum brightness, silhouette always"):
    // sparse VNC dots stay visible, dense optic lobes don't stack their halos into a milky blob
    vec3 col = rest * baseGlow * keepRest * beacon * (core * 2.2 + halo * 0.35) + spark * hot * keepHot * beacon * (core * 1.6 + halo * 0.4);
    // `core` and `halo` are already ~0 at d >= 1 (exp(-5) = 0.007), so the old `inside` mask and its
    // two multiplies bought nothing; the branch on alpha becomes a min()
    float a = min(1.0, (baseGlow * keepRest + hot * keepHot) * beacon * halo);
    vertexColor = vec4(col, a);
}
