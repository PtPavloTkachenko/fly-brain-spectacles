"""Sense channels -> MaleCNS cell types, and command readouts -> fly actions.

Every mapping comes from `brain/atlas.py` (see docs/knowledge/COMPONENTS.md "Decoder from the
full atlas"). Senses are injected at the fly's own feature detectors (VPN level) because raw
pixels barely reach behaviour in this model. The action decoder is an engineered interface:
which cells we read is chosen from measured responses, the scaling constants are ours.
"""

import re

import numpy as np

MAX_MV = 20.0  # current for a channel at value 1.0 (the atlas probe amplitude)

# name: (type regex, side column or None, subclass filter or None)
SENSES = {
    "loom": (r"^(LC4|LPLC2)$", "soma", None),  # a THREAT approaching (hand, head, fast object) -> escape suite
    # a surface closing in on the eyes (walls, ceiling: FlyEyes rays) -> LPLC1 -> DNp03 +186 Hz, escape only
    # +12 (atlas): the fly turns away instead of bolting (11.09: wall loom in LC4/LPLC2 = escape loops)
    "loom_wall": (r"^LPLC1$", "soma", None),
    "object": (r"^(LC12|LPC1|LC10a|LC10d)$", "soma", None),  # small object on that side -> orient/steer
    "motion": (r"^LLPC1$", "soma", None),  # wide-field motion on that side -> DNa02 same side
    "odor": (r"^ORN_(DM1|DM2|DM4|VA2)$", "root", None),  # fruit / vinegar
    # Odour IDENTITY (ADR 62 follow-up). The generic `odor` above drives all four glomeruli at
    # once, so every smell in the room was literally the same smell and no memory could ever be
    # cue-specific. These four add a per-glomerulus component ON TOP of it, so two things can
    # differ. Measured on the graph (2 hops, |w| >= 1): DM1 reaches 1410 Kenyon cells, DM2 1209,
    # DM4 1295, VA2 1388 of 4064, and the pairs differ — Jaccard 0.243 (DM4/VA2) to 0.778
    # (DM1/DM4). So the separation is real, and it is the connectome's own, not ours.
    "odor_dm1": (r"^ORN_DM1$", "root", None),
    "odor_dm2": (r"^ORN_DM2$", "root", None),
    "odor_dm4": (r"^ORN_DM4$", "root", None),
    "odor_va2": (r"^ORN_VA2$", "root", None),
    # Twelve more glomeruli (ADR 105, 21.09 Pavlo: "the brain recognises many more smells, and I do
    # not see it"). The brain has 53 ORN glomeruli in the annotation table; the four above were the
    # export's ceiling, not the brain's (ADR 94). Each of these has ONE well-established best ligand
    # (Hallem & Carlson 2006 Cell 125:143; DoOR 2.0, Muench & Galizia 2016), so the caption can name
    # the smell in a nose's words. Cell counts are the L/R rootSide cells the export finds (see the
    # ADR). Excluded on purpose: DA2 (geosmin) and V (CO2) are `odor_bad` below; DA1/VA1v/VA1d are
    # pheromone glomeruli, nothing in a room smells of them.
    "odor_dm3": (r"^ORN_DM3$", "root", None),  # Or47a: pentyl acetate -- banana
    "odor_dl5": (r"^ORN_DL5$", "root", None),  # Or7a: E2-hexenal -- cut green leaves
    "odor_dc1": (r"^ORN_DC1$", "root", None),  # Or19a: (+)-valencene -- citrus peel
    "odor_vm2": (r"^ORN_VM2$", "root", None),  # Or43b: ethyl butyrate -- pineapple candy
    "odor_va6": (r"^ORN_VA6$", "root", None),  # Or82a: geranyl acetate -- rose
    "odor_dc2": (r"^ORN_DC2$", "root", None),  # Or13a: 1-octen-3-ol -- mushroom
    "odor_dl1": (r"^ORN_DL1$", "root", None),  # Or10a: methyl salicylate -- wintergreen
    "odor_vl2a": (r"^ORN_VL2a$", "root", None),  # Ir84a: phenylacetic acid -- honey
    "odor_vm1": (r"^ORN_VM1$", "root", None),  # Ir92a: ammonia, amines -- sharp ammonia
    "odor_dm5": (r"^ORN_DM5$", "root", None),  # Or85a: ethyl 3-hydroxybutyrate -- fruity-sweet
    "odor_vm7d": (r"^ORN_VM7d$", "root", None),  # Or42a: propyl acetate -- pear drops
    "odor_va7l": (r"^ORN_VA7l$", "root", None),  # Or46a: 4-methylphenol -- barnyard
    "odor_bad": (r"^ORN_(V|DA2)$", "root", None),  # CO2, geosmin (aversive in flies)
    "wind": (r"^JO-[CE]", "root", None),
    "touch": (r"SNta0[29]", "root", "notum"),  # bristles on the back
    # The grooming trigger (12.09). BM = the bristle mechanosensory neurons of the head and body,
    # 39 L / 30 R. Measured in this model: stimulating them lifts DNg12 (the grooming command) from
    # ~1.4 Hz to +7.8 (L) / +14.8 (R); wind on the antennae does the same; sweet contact leaves it
    # at 0 (feeding beats cleaning). The lens sends contact/dust load; the brain picks the moment.
    "bristle": (r"^BM$", "root", None),
    "sound": (r"^JO-[AB]", None, None),
    # sweet contact: LB3c + leg claw GRNs + TPMN1/2 proboscis contact (feed +70 Hz, audit sim 11.09);
    # LB4b dropped - alone it drives the stop neuron DNpe007 +52 Hz (atlas)
    "sweet": (r"^(LB3c|claw_tpGRN|TPMN1|TPMN2)$", None, None),
    "bitter": (r"^(LB1c|LB2a|LB2c|LgAG1)$", None, None),
    "hot": (r"^TRN_VP2$", None, None),  # assumption: VP2 = hot cells
    "cold": (r"^TRN_VP3[ab]$", None, None),  # assumption: VP3 = cold cells
    "dry": (r"^HRN_VP4$", None, None),  # assumption: VP4 = dry
    "moist": (r"^HRN_VP5$", None, None),  # assumption: VP5 = moist
    "reward": (r"^PAM11$", None, None),  # artificial dopamine (disclose on the board)
    "punish": (r"^PPL101$", None, None),
    # Hunger (12.09 Pavlo: "wouldn't the brain itself call it to go and eat?"). It would not: the
    # connectome has no gut. Measured in the atlas, EVERY driver of the appetitive descending
    # neurons is food already touching the fly (LB3c +49, TPMN1 +38, claw_tpGRN +33 Hz) and DNp09,
    # the walk command, sits at 0 Hz and answers nothing. So starvation cannot reach this brain on
    # its own. We inject it where a real fly's hunger peptides act: as a current into the appetitive
    # DNs themselves. Engineered and disclosed (ADR) — and note it is deliberately circular, the
    # `appetite` readout reads the cells we drive, exactly like `reward`/PAM11 already does.
    "hunger": (r"^(DNge051|DNge023|DNge173)$", None, None),
    # The OCELLI (ADR 68): the three simple eyes on the dorsal head. They are brightness-gradient
    # detectors, not image formers, and in every insect studied they drive a fast gaze/body
    # righting reflex through the neck motor neurons (Taylor 1981 in locust; Parsons, Krapp &
    # Laughlin 2010 for the ocellar L-neuron -> descending -> neck pathway in the blowfly).
    # MaleCNS HAS the ocellar ganglion output cells - OCG01a/b, OCG02b/c, OCG03 - and OCG01b is
    # the single strongest direct sensory->neck path in the whole model (sum_w +302.8 over 14
    # edges; HS gives +30..+88, VS +162.8). What it does NOT have is the ocellar photoreceptor
    # layer: OCG01a's only inputs are other OCG cells and central neurons. So, exactly as for the
    # compound eye in ADR 54, we supply what the missing receptors would supply and say so.
    # Sided by soma, so left-vs-right IS the roll signal.
    "ocelli": (r"^(OCG01a|OCG01b|OCG02b|OCG02c|OCG03)$", "soma", None),
    # The HALTERES (ADR 71): the hind-wing gyroscopes. 205 afferents in MaleCNS, all entering
    # through the dorsal metathoracic nerve (DMetaN, the haltere nerve), 104 left / 101 right by
    # rootSide, 26,638 outgoing edges and 100 % of them excitatory. Unlike the ocelli this is a
    # BROAD projection, not a bottleneck: haltere -> neck MNs +998.8 over 603 edges (the ocellar
    # OCG01b managed +302.8 over 14), -> wing MNs +1007.6 over 524, -> descending neurons +1040.9
    # over 1108. The receptors themselves are all here; what is missing is the BEATING, so as with
    # the eye and the ocelli we supply what the mechanics would supply - see the ADR for the
    # rate-proportional encoding and its sign convention.
    "haltere": (r"^", "root", "haltere"),
}

READOUTS = {
    "DNa02_L": (["DNa02"], "L"), "DNa02_R": (["DNa02"], "R"),
    "DNp66_L": (["DNp66"], "L"), "DNp66_R": (["DNp66"], "R"),
    "esc_L": (["DNp01", "DNp02", "DNp04", "DNp11"], "L"),
    "esc_R": (["DNp01", "DNp02", "DNp04", "DNp11"], "R"),
    "stop": (["DNpe007"], None),
    "back": (["MDN"], None),
    "feed": (["MN9"], None),
    "appetite": (["DNge051", "DNge023", "DNge173"], None),
    "walk": (["DNp09"], None),
    "reward": (["PAM11"], None),
    "stress": (["PPL101"], None),
    # The two mushroom-body output neurons the plastic synapses actually feed (ADR 62). Without
    # them the only learning signal on the wire was `memory.mean_efficacy`, a mean over 7,835
    # synapses — the weight, never the OUTPUT. MBON07 (alpha1, 4 cells) is the PAM11/appetitive
    # compartment's output, MBON11 (gamma1pedc, 2 cells) the PPL101/aversive one. A conditioned
    # response shows up here as a CS+ rate that moves while the CS- rate does not.
    "MBON07": (["MBON07"], None),
    "MBON11": (["MBON11"], None),
    # APL: the one giant GABAergic neuron per hemisphere that every Kenyon cell excites and that
    # inhibits them all back. It is the mushroom body's own sparsening loop (ADR 67) and the only
    # way to see, live, whether that loop is running.
    "APL": (["APL"], None),
    # Flight saccades (ADR 22 follow-up, research 11.09): DNa15 (excitatory) + DNb01 (inhibitory)
    # generate spontaneous saccades, VES041 suppresses them (Ros, Omoto & Dickinson 2024); DNp03
    # gets loom (LPLC1/LC4) and triggers them. One cell per side each in MaleCNS.
    "DNa15_L": (["DNa15"], "L"), "DNa15_R": (["DNa15"], "R"),
    "DNb01_L": (["DNb01"], "L"), "DNb01_R": (["DNb01"], "R"),
    "DNp03_L": (["DNp03"], "L"), "DNp03_R": (["DNp03"], "R"),
    "VES041": (["VES041"], None),
    # The optic lobe itself (ADR 54): once the eye is injected these are what the board shows and
    # what the vision battery scores. LC4 (Ache et al. 2019) and LPLC2 (Klapoetke et al. 2017) are
    # the looming detectors; LC11 answers small moving objects and takes NO T4/T5 input, so it is
    # not a motion detector (Keles & Frye 2017); LPLC1 is the wall-loom / turn-away channel.
    "LC4_L": (["LC4"], "L"), "LC4_R": (["LC4"], "R"),
    "LPLC2_L": (["LPLC2"], "L"), "LPLC2_R": (["LPLC2"], "R"),
    "LPLC1_L": (["LPLC1"], "L"), "LPLC1_R": (["LPLC1"], "R"),
    "LC11_L": (["LC11"], "L"), "LC11_R": (["LC11"], "R"),
    # The HORIZON system (ADR 68). Lobula plate tangential cells: HS reads horizontal wide-field
    # flow (driven by T4a/T5a, sum_w +3985/+4560), VS reads vertical (T4d/T5d, +14029/+14227).
    # Both reach the neck motor neurons DIRECTLY (HSE +42.9, HSN +30.3, HSS +49.8, H2 +87.7,
    # VS +162.8) and through DNp15 (+260.4 to neck), DNp17 (+143.6) and DNp20 (+57.2).
    # Measured 15.09: they already fire from the compound eye built in ADR 54 - 0 Hz on a blank
    # field, 100-146 Hz under wide-field motion - and nothing was reading them.
    "HSE_L": (["HSE"], "L"), "HSE_R": (["HSE"], "R"),
    "HSN_L": (["HSN"], "L"), "HSN_R": (["HSN"], "R"),
    "HSS_L": (["HSS"], "L"), "HSS_R": (["HSS"], "R"),
    "H2_L": (["H2"], "L"), "H2_R": (["H2"], "R"),
    "VS_L": (["VS"], "L"), "VS_R": (["VS"], "R"),
    "DNp15_L": (["DNp15"], "L"), "DNp15_R": (["DNp15"], "R"),
    "DNp17_L": (["DNp17"], "L"), "DNp17_R": (["DNp17"], "R"),
    "DNp20_L": (["DNp20"], "L"), "DNp20_R": (["DNp20"], "R"),
    # the ocellar interneurons themselves, so the board can show what the injection did
    "OCG01a_L": (["OCG01a"], "L"), "OCG01a_R": (["OCG01a"], "R"),
    "OCG01b_L": (["OCG01b"], "L"), "OCG01b_R": (["OCG01b"], "R"),
    "OCG02b_L": (["OCG02b"], "L"), "OCG02b_R": (["OCG02b"], "R"),
    "OCG03_L": (["OCG03"], "L"), "OCG03_R": (["OCG03"], "R"),
    # The rest of the ocellar DESCENDING pool (ADR 70, way 1). DNp20 alone is one cell a side and
    # its 150 ms rate is quantised in ~7 Hz steps, so its noise is the size of its own range. These
    # are the other descending targets the ocellar ganglion drives, measured: DNge107 4.0 -> 34.7 Hz,
    # DNp19 +29.3, DNp22 0 -> 6.0, DNp102 0 -> 6.7 at channel 1.0.
    "DNp19_L": (["DNp19"], "L"), "DNp19_R": (["DNp19"], "R"),
    "DNp22_L": (["DNp22"], "L"), "DNp22_R": (["DNp22"], "R"),
    "DNp102_L": (["DNp102"], "L"), "DNp102_R": (["DNp102"], "R"),
    "DNge107_L": (["DNge107"], "L"), "DNge107_R": (["DNge107"], "R"),
}


def index_senses(a):
    types = a.type.fillna("").to_numpy()
    sides = {"soma": a.somaSide.fillna("").to_numpy(), "root": a.rootSide.fillna("").to_numpy()}
    sub = a.subclass.fillna("").to_numpy()
    out = {}
    for name, (pattern, side, subclass) in SENSES.items():
        rx = re.compile(pattern)
        m = np.array([bool(rx.search(t)) for t in types])
        if subclass:
            m &= sub == subclass
        if side:
            out[name] = {s: np.flatnonzero(m & (sides[side] == s)).astype(np.int32) for s in "LR"}
        else:
            out[name] = {"both": np.flatnonzero(m).astype(np.int32)}
    return out


def index_regions(superclass, types):
    """Whole populations for the board's region bars (and the cloud's hover highlight).
    Unlike single command cells — several genuinely silent at rest — they always fluctuate."""
    sc = np.asarray(superclass).astype(str)
    types = np.asarray(types).astype(str)
    return {
        "optic": np.flatnonzero(np.char.startswith(sc, "ol_") | (sc == "visual_projection")),
        "central": np.flatnonzero(sc == "cb_intrinsic"),
        "mushroom": np.flatnonzero(np.char.startswith(types, "KC")),
        "descending": np.flatnonzero(np.char.find(sc, "descending") >= 0),
        "vnc": np.flatnonzero(np.char.startswith(sc, "vnc_")),
        "motor": np.flatnonzero(np.char.find(sc, "motor") >= 0),
        "sensory": np.flatnonzero(np.char.find(sc, "sensory") >= 0),
    }


def index_readouts(a):
    types = a.type.fillna("").to_numpy()
    soma = a.somaSide.fillna("").to_numpy()
    out = {}
    for name, (names, side) in READOUTS.items():
        m = np.isin(types, names)
        if side:
            m &= soma == side
        out[name] = np.flatnonzero(m).astype(np.int32)
    # Sound from the brain (11.09): the 67 wing motor neurons (subclass "wm": power DLM/DVM +
    # steering b1/b2/i1/i2/hg...) drive the buzz; pIP10 is the courtship-song command DN.
    sc = a.superclass.fillna("").astype(str).to_numpy()
    sub = a.subclass.fillna("").astype(str).to_numpy()
    wm = (np.char.find(sc.astype(str), "motor") >= 0) & (sub == "wm")
    out["wing"] = np.flatnonzero(wm).astype(np.int32)
    out["song"] = np.flatnonzero(types == "pIP10").astype(np.int32)
    # T4 (ON) / T5 (OFF) elementary motion detectors, the whole family per side (ADR 54).
    for pref in ("T4", "T5"):
        fam = np.char.startswith(types.astype(str), pref)
        for side in "LR":
            out[pref + "_" + side] = np.flatnonzero(fam & (soma == side)).astype(np.int32)
    # Flight from the motor output itself (11.09 "isn't flight controlled by the brain?"):
    # power = the indirect flight-muscle motor neurons (DLM/DVM: thrust + lift), steer = every other
    # wing motor neuron (b1/b2/i1/i2/iii/hg/tp/ps1: stroke asymmetry -> turning), per body side.
    power = wm & (np.char.startswith(types.astype(str), "DLMn") | np.char.startswith(types.astype(str), "DVMn"))
    steer = wm & ~power
    for side in "LR":
        out["power_" + side] = np.flatnonzero(power & (soma == side)).astype(np.int32)
        out["steermn_" + side] = np.flatnonzero(steer & (soma == side)).astype(np.int32)
    # Flight thrust at the DN level (ADR 22, research 11.09): DNg02 is a population (29 cells,
    # DNg02_a.._g) that sets wingbeat amplitude by a population code (Namiki et al. 2022, Curr
    # Biol); oDN1 is the forward-speed DN Eon Systems read for NeuroMechFly. Per side too.
    ts = types.astype(str)
    dng02 = np.char.startswith(ts, "DNg02")
    out["dng02"] = np.flatnonzero(dng02).astype(np.int32)
    for side in "LR":
        out["dng02_" + side] = np.flatnonzero(dng02 & (soma == side)).astype(np.int32)
    out["odn1"] = np.flatnonzero(ts == "oDN1").astype(np.int32)
    # 12.09 Pavlo: "hook as much as possible up to the brain". The remaining motor pools, by
    # subclass and body side. Every one was measured in this LIF model first (brain/probe harness,
    # 12.09) so no bone hangs off a silent cell the way DNg02 did:
    #   nm  neck      22/side  rest 9-13 Hz, sweet +6..+10, wind -3..-7  -> head turn
    #   am  antenna   6-7      rest 13/30,   bristles +21, sweet -17     -> antennae
    #   pm  proboscis 33       rest 3.5,     sweet +10                   -> proboscis (MN9 is one)
    #   ad  abdomen   107      rest 13,      wind +5                     -> abdomen pump
    #   fl/ml/hl legs 58-68    rest 2-6,     +-1..3                      -> stride amplitude only:
    #       too weak to BE the gait, so the brain sets how hard the legs push, not the rhythm.
    motor = np.char.find(sc.astype(str), "motor") >= 0
    for key, name in (("nm", "neck"), ("am", "ant"), ("pm", "prob"), ("ad", "abd"),
                      ("fl", "legf"), ("ml", "legm"), ("hl", "legh")):
        pool = motor & (sub == key)
        for side in "LR":
            out[name + "_" + side] = np.flatnonzero(pool & (soma == side)).astype(np.int32)
    # Grooming command: DNg12 is a family (DNg12_a..h), 21 cells a side — an exact type match misses
    # every one of them.
    g12 = np.char.startswith(ts, "DNg12")
    for side in "LR":
        out["groom_" + side] = np.flatnonzero(g12 & (soma == side)).astype(np.int32)
    return out


def build_stim(ix, senses):
    """senses: {channel: v | {"L": v, "R": v}} with v in 0..1 -> [(indices, mV)]."""
    stim = []
    for name, value in senses.items():
        if name not in ix:
            continue
        groups = ix[name]
        if isinstance(value, dict):
            items = [(groups.get(s, groups.get("both")), value.get(s, 0.0)) for s in ("L", "R")]
        else:
            items = [(cells, value) for cells in groups.values()]
        for cells, v in items:
            v = float(np.clip(v, 0.0, 1.5))
            if cells is not None and len(cells) and v > 0:
                stim.append((cells, MAX_MV * v))
    return stim


def _dead(x, zone):
    """Deadzone: resting drift (±0.3 on a single DNa02 cell) must not read as a turn."""
    return 0.0 if abs(x) < zone else (x - zone * (1 if x > 0 else -1)) / (1 - zone)


DNG02_RANGE_HZ = 20.0  # DNg02 change (Hz, vs its habituating baseline) from half to full thrust — tune from live data
POWER_RANGE_HZ = 48.0  # DLM/DVM power-MN change (Hz, vs baseline) -> +-0.5 thrust: now only a slow gain (was 24)
THRUST_REST = 0.45  # resting flight drive
FIXATION_RANGE_HZ = 50.0
AVOID_RANGE_HZ = 120.0  # DNp03 L-R difference for a full turn away from a looming surface (LPLC1 -> DNp03 ~+150-186 Hz)
SACC_RANGE_HZ = 60.0  # (DNa15 - DNb01) difference between the sides for a full-size saccade
VES_RANGE_HZ = 40.0  # VES041 suppresses saccades (Ros, Omoto & Dickinson 2024)
# Motor pools (12.09). Each range is the measured rise of that pool over its own resting rate at a
# full 20 mV stimulus, so 1.0 = "as hard as this model ever drives that muscle group".
GROOM_RANGE_HZ = 5.0  # DNg12: the isolated probe rose +8..+15 Hz; the live brain lifts ~3.5 Hz at a full bristle load (ADR 106, was 12)
NECK_RANGE_HZ = 8.0  # neck MN left-right difference for a full head turn
ANT_RANGE_HZ = 18.0  # antennal MNs: +21 Hz on bristle contact
PROB_RANGE_HZ = 10.0  # proboscis MNs: +10 Hz at sweet contact
ABD_RANGE_HZ = 6.0  # abdominal MNs: +5 Hz in wind
LEG_RANGE_HZ = 3.0  # leg MNs move only +-1..3 Hz: a stride gain, not a gait


def decode(rate, base):
    """Smoothed readout rates (Hz) minus the fly's own neutral baseline -> actions in 0..1 / -1..1.

    Measured through fake_lens (5 brains): motion L/R -> turn -0.92/+1.00, object L/R ->
    orient -1/+1, loom L/R -> escape on that side 1.0, sweet -> feed 0.97, bitter/touch/heat
    -> stop 1.0. MDN (`back`) is driven by the object channel (LC10: +36 Hz, audit sim 11.09), NOT
    by odour (+-4 Hz); `back` only counts without a target in view and never touches flight.
    """
    d = {k: rate[k] - base[k] for k in rate}
    clip = lambda x, lo=0.0, hi=1.0: float(min(hi, max(lo, x)))
    esc_l, esc_r = clip(d["esc_L"] / 100), clip(d["esc_R"] / 100)
    stop = clip(d["stop"] / 80)
    appetite = clip(d["appetite"] / 40)
    turn = _dead(clip((d["DNa02_R"] - d["DNa02_L"]) / 60, -1, 1), 0.35)  # + = right
    orient = _dead(clip((d["DNp66_R"] - d["DNp66_L"]) / 50, -1, 1), 0.2)
    avoid = _dead(clip((d.get("DNp03_L", 0.0) - d.get("DNp03_R", 0.0)) / AVOID_RANGE_HZ, -1, 1), 0.15)
    # Saccade trigger (ADR 22 research, 12.09): DNa15 excites and DNb01 inhibits the spontaneous
    # saccade generator on each side, VES041 suppresses it; the loom-driven ones already arrive
    # through DNp03 (`avoid`). Signed, + = a flick to the right. The BODY decides the template;
    # this only says "flick now, this hard, this way".
    sacc_r = d.get("DNa15_R", 0.0) - d.get("DNb01_R", 0.0)
    sacc_l = d.get("DNa15_L", 0.0) - d.get("DNb01_L", 0.0)
    ves = clip(d.get("VES041", 0.0) / VES_RANGE_HZ)
    sacc = _dead(clip((sacc_r - sacc_l) / SACC_RANGE_HZ, -1, 1), 0.2) * (1.0 - ves)
    approach = max(appetite, 0.8 * abs(orient))
    back = clip(d["back"] / 20) if abs(orient) < 0.2 else 0.0
    # Thrust from the brain (ADR 22): the DNg02 population sets wingbeat amplitude, so forward
    # flight = 0.5 at the fly's own resting DNg02 level, more/less as the population rises/falls;
    # DNpe007 stop, escape and the MDN back command still take it away.
    # 11.09 live: DNg02 is ~silent in this LIF model (0-0.5 Hz) while the DLM/DVM power motor neurons
    # fire 64-91 Hz and move with the network — so thrust = the power MNs relative to their own
    # habituating baseline (research: "a slow power gain, relative to baseline"), DNg02 on top
    power = (d.get("power_L", 0.0) + d.get("power_R", 0.0)) / 2
    # Approach drive (audit 11.09, offline sim): an attractive object ahead raises DNp66 on BOTH
    # sides (+29/+32 Hz) while it LOWERS the power MNs by 12-14 Hz, so thrust from the power MNs
    # alone fell to ~0.06 and hungry flies hovered in front of food. Thrust = resting drive +
    # approach (bilateral DNp66 fixation, or orient toward a side) + the power MNs as a slow gain.
    # Motor pools -> the rest of the body (12.09). Each is that pool's rise over its OWN baseline,
    # so a fly with a lopsided resting rate (the antennal MNs rest at 13 Hz left, 30 Hz right) is
    # still read symmetrically.
    pool = lambda n: (d.get(n + "_L", 0.0) + d.get(n + "_R", 0.0)) / 2
    groom = clip(pool("groom") / GROOM_RANGE_HZ)
    neck = _dead(clip((d.get("neck_R", 0.0) - d.get("neck_L", 0.0)) / NECK_RANGE_HZ, -1, 1), 0.15)
    ant = clip(pool("ant") / ANT_RANGE_HZ, -1, 1)
    prob = clip(pool("prob") / PROB_RANGE_HZ)
    abd = clip(pool("abd") / ABD_RANGE_HZ, -1, 1)
    legs = clip((pool("legf") + pool("legm") + pool("legh")) / (3 * LEG_RANGE_HZ), -1, 1)
    # ...and each leg on its own pool, so the six legs push independently (12.09 Pavlo: "I thought
    # the brain controlled the legs"). It does now — for how hard each one pushes. The tripod
    # RHYTHM stays ours and is disclosed: these pools never alternate (measured).
    leg6 = {k: clip(d.get(k, 0.0) / LEG_RANGE_HZ, -1, 1)
            for k in ("legf_L", "legf_R", "legm_L", "legm_R", "legh_L", "legh_R")}
    fixation = clip(((d["DNp66_L"] + d["DNp66_R"]) / 2) / FIXATION_RANGE_HZ)
    drive = max(fixation, 0.8 * abs(orient))
    if "power_L" in d:
        thrust = clip(THRUST_REST + 0.65 * drive + power / POWER_RANGE_HZ + d.get("dng02", 0.0) / DNG02_RANGE_HZ)
    else:
        thrust = clip(0.25 + 0.75 * approach)
    return {
        "turn": turn,
        "orient": orient,
        # avoid: a surface looming on the left fires DNp03_L -> turn right (+), and vice versa
        "avoid": avoid,
        "steer": clip(turn + orient + avoid, -1, 1),  # what the body uses
        "sacc": sacc,  # + = flick right; the body turns this into a ~50 ms, ~90 deg saccade
        "escape_L": esc_l,  # threat on the left -> flee right
        "escape_R": esc_r,
        "stop": stop,
        "back": back,
        "feed": clip(d["feed"] / 30),
        "appetite": appetite,
        "thrust": thrust,
        # MDN ("moonwalker") is the backward-WALK command: it no longer eats flight thrust (its driver
        # is the object channel, LC10 - audit sim 11.09).
        "forward": clip(thrust - stop - max(esc_l, esc_r)),
        # --- the rest of the body, straight off its motor pools (12.09) -------------------------
        # The bones these drive used to run on timers and sine waves. Now the brain holds them.
        "groom": groom,  # DNg12: the fly decides to clean itself
        "neck": neck,  # neck MN left-right: head turn (+ = right)
        "ant": ant,  # antennal MN pool: how hard the antennae sweep
        "prob": prob,  # proboscis MN pool (MN9 is one of 33): extension
        "abd": abd,  # abdominal MN pool: pump depth
        "legs": legs,  # all six pools together (the board's one-number summary)
        # ...and each leg on its own pool. Measured 12.09: the two tripods correlate +0.42 (they
        # fire TOGETHER) and the strongest autocorrelation is +0.17 at 80 ms, nowhere near a 3 Hz
        # gait — so these pools cannot BE the walking rhythm. They set how hard each leg pushes;
        # the tripod pattern stays ours and is disclosed as such.
        **leg6,
    }
