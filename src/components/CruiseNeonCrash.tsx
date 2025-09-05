import React, { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence, useAnimation } from "framer-motion";
import { Volume2, VolumeX, Ship as ShipIcon, Zap, TimerReset, Trophy, Anchor, HelpCircle } from "lucide-react";
import shipPng from "../assets/ship.png";
import icePng from "../assets/ice.png";

/**
 * Cruise Neon Crash — Hidden Iceberg Edition
 * ------------------------------------------------
 * Changes implemented per request:
 * • Icebergs are visually identical to normal ice (no text, no icon, no tell).
 * • Ship continuously sails; loop is endless until crash.
 * • On safe ice impact: ice cracks into shards and sinks.
 * • On iceberg impact: ice stays; ship tilts and sinks.
 * • RTP "fair but not too fair": progressive crash hazard + realistic multiplier distribution.
 * • 5% lifeboat survival preserved.
 * • Smooth rAF loop with moving obstacles; Cash Out anytime while running.
 * • Clean neon visuals with an actual ice-looking block (SVG facets & glow).
 */

// ---------- Types ----------

type Phase = "idle" | "betting" | "running" | "cashed" | "crashed" | "lifeboat";

// (VisChunk removed — replaced by moving Obstacle model)

type Obstacle = {
  id: string;
  x: number; // px from left of lane
  width: number;
  height: number;
  multiplier: number;
  iceberg: boolean;
  state: "idle" | "breaking"; // breaking triggers crack animation then removal
  bornAt: number; // ms timestamp for spawn; collisions ignored briefly after spawn
};

// ---------- Helpers ----------

const rand = (min: number, max: number) => Math.random() * (max - min) + min;
const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
const fmtMult = (m: number) => `${m.toFixed(2)}x`;

// Fixed iceberg probability helper (same for every ice)
function icebergChance(): number {
  // fixed probability for all ice — 40%
  return 0.4;
}

// (makeChunk removed — obstacles are spawned directly in the rAF loop)

// ---------- Visual Bits ----------

const NeonGlow: React.FC<{ className?: string }> = ({ className }) => (
  <div className={`pointer-events-none absolute inset-0 opacity-80 ${className ?? ""}`} aria-hidden>
    <div className="absolute -top-20 left-10 h-64 w-64 rounded-full blur-3xl bg-cyan-500/30" />
    <div className="absolute top-10 right-20 h-72 w-72 rounded-full blur-3xl bg-fuchsia-500/25" />
    <div className="absolute bottom-10 left-1/4 h-80 w-80 rounded-full blur-[100px] bg-indigo-500/20" />
    <div className="absolute -bottom-20 right-1/5 h-72 w-72 rounded-full blur-[92px] bg-emerald-500/20" />
  </div>
);

const NeonDivider: React.FC = () => (
  <div className="h-px w-full bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent" />
);

// Ship now uses PNG texture; motion is applied via `controls`

// Ice visual now uses PNG; on breaking it immediately sinks smoothly
const IceBlock: React.FC<{ label: string; state: "idle" | "breaking" | "static" }> = ({ label, state }) => (
  <motion.div
    className="relative select-none w-[120px] h-[60px]"
    initial={{ y: 6, opacity: 0 }}
    animate={
      state === "breaking"
        ? { y: 140, opacity: 0, filter: "blur(1px)" }
        : { y: 0, opacity: 1, filter: "blur(0px)" }
    }
    transition={{ duration: state === "breaking" ? 0.9 : 0.35, ease: [0.22, 0.61, 0.36, 1] }}
  >
    <img src={icePng} alt="Ice" width={220} height={110} className="pointer-events-none object-contain" draggable={false} />
    {/* Multiplier label (always visible) */}
    <div className="absolute -top-6 left-1/2 -translate-x-1/2 text-3xl font-black text-cyan-200 drop-shadow-[0_0_16px_rgba(34,211,238,0.55)] pointer-events-none">
      {label}
    </div>
  </motion.div>
);

// Neon button
const NeonButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "danger" | "ghost" }> = ({ children, className, variant = "primary", ...props }) => (
  <button
    className={`${variant === "primary" ? "bg-emerald-500/20 border-emerald-300/60 hover:bg-emerald-500/30" : variant === "danger" ? "bg-red-500/20 border-red-400/60 hover:bg-red-500/30" : "bg-white/5 border-white/20 hover:bg-white/10"} border rounded-2xl px-4 py-2 text-white backdrop-blur-md transition-colors ${className ?? ""}`}
    {...props}
  >
    {children}
  </button>
);

// ---------- Main Component ----------

const CruiseNeonCrash: React.FC = () => {
  const [phase, setPhase] = useState<Phase>("idle");
  const [balance, setBalance] = useState<number>(1000);
  const [bet, setBet] = useState<number>(10);
  const [muted, setMuted] = useState<boolean>(false);
  const [message, setMessage] = useState<string>("");
  const [countdown, setCountdown] = useState<number>(0);

  // game model
  const [collected, setCollected] = useState<number>(1);
  const [safeHits, setSafeHits] = useState<number>(0);
  const [obstacles, setObstacles] = useState<Obstacle[]>([]);
  // locked bet for current round
  const [activeBet, setActiveBet] = useState<number | null>(null);
  const activeBetRef = useRef<number>(0);
  useEffect(() => { activeBetRef.current = activeBet ?? 0; }, [activeBet]);
  // single-cash-out guard
  const [hasCashed, setHasCashed] = useState<boolean>(false);
  const hasCashedRef = useRef<boolean>(false);
  useEffect(() => { hasCashedRef.current = hasCashed; }, [hasCashed]);
  // whether user joined this round with a bet
  const [joined, setJoined] = useState<boolean>(false);
  const joinedRef = useRef<boolean>(false);
  useEffect(() => { joinedRef.current = joined; }, [joined]);

  const controls = useAnimation();
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  // timing constant and dynamic speed
  const HIT_INTERVAL = 2.0; // seconds between ship/ice contact
  const speedRef = useRef<number>(320);
  // spawn scheduler: accumulate dt to spawn on cadence
  const spawnAccumRef = useRef<number>(0);
  const laneWidthRef = useRef<number>(980); // approx inner width of stage
  const laneElRef = useRef<HTMLDivElement | null>(null);
  const shipElRef = useRef<HTMLDivElement | null>(null);
  const shipBoundsRef = useRef<{ left: number; right: number }>({ left: 10, right: 150 });
  // Horizontal visual offset for the ship (px). Increase to move ship to the right.
  const SHIP_OFFSET_X = 24;
  // Global speed multiplier to make ice move faster/slower without changing 2s TTC
  const SPEED_MULTIPLIER = 1.5; // try 1.1–1.5
  // Manual collision padding (px). Tweak these to adjust when "touch" occurs without moving visuals.
  // Positive SHIP_RIGHT_PAD causes earlier touches; negative delays. ICE pads trim the iceberg hitbox.
  const SHIP_LEFT_PAD = 0;
  const SHIP_RIGHT_PAD = 0;
  const ICE_LEFT_PAD = 50;
  const ICE_RIGHT_PAD = 0;
  // (cash-out threshold removed per request)
  // Persistence (round only)
  const SS_KEYS = {
    roundActive: 'cnc_roundActive',
    roundId: 'cnc_roundId',
  } as const;
  const roundIdRef = useRef<number>(Number(sessionStorage.getItem(SS_KEYS.roundId) || '0'));
  // Planned multiplier sequence controller
  // - 1st ice: random 1.1x–1.3x
  // - 2nd–5th: randomly increase but do not exceed 2.1x
  // - 6th+: random additive increment between +1x and +3x
  const nextIndexRef = useRef<number>(1);
  const plannedMultRef = useRef<number>(1);
  const planNextMultiplier = () => {
    const idx = nextIndexRef.current;
    let next = plannedMultRef.current;
    if (idx === 1) {
      next = parseFloat(rand(1.1, 1.3).toFixed(2));
    } else if (idx >= 2 && idx <= 5) {
      const inc = rand(0.05, 0.3);
      next = Math.min(2.1, plannedMultRef.current + inc);
      if (next <= plannedMultRef.current) next = Math.min(2.1, plannedMultRef.current + 0.05);
      next = parseFloat(next.toFixed(2));
    } else {
      const inc = parseFloat(rand(1.0, 3.0).toFixed(2));
      next = parseFloat((plannedMultRef.current + inc).toFixed(2));
    }
    plannedMultRef.current = next;
    nextIndexRef.current = idx + 1;
    return next;
  };

  // No multiplier restoration needed

  // No complex multiplier function; sequential integers only

  // refs to avoid stale closures in rAF
  const phaseRef = useRef<Phase>("idle");
  useEffect(() => { phaseRef.current = phase; }, [phase]);
  const safeHitsRef = useRef<number>(0);
  useEffect(() => { safeHitsRef.current = safeHits; }, [safeHits]);
  const collectedRef = useRef<number>(1);
  useEffect(() => { collectedRef.current = collected; }, [collected]);
  const betRef = useRef<number>(bet);
  useEffect(() => { betRef.current = bet; }, [bet]);
  // Snapshot of obstacles for rAF loop to compute next frame outside of setState updater
  const obstaclesRef = useRef<Obstacle[]>([]);
  useEffect(() => { obstaclesRef.current = obstacles; }, [obstacles]);
  // Dedup scheduled removals for breaking ice
  const removalScheduledRef = useRef<Set<string>>(new Set());
  // Helper: commit obstacle updates to both ref (for rAF) and React state (for render)
  const commitObstacles = (next: Obstacle[]) => {
    obstaclesRef.current = next;
    setObstacles(next);
  };
  // Scrolling world model: we move the lane via transform, obstacles keep worldX in `x`
  const laneScrollElRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<number>(0);
  // Layout readiness gating for accurate first-round timing
  const shipLoadedRef = useRef<boolean>(false);
  const measuredReadyRef = useRef<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);

  // Auto-restart timer ref
  const restartTimeoutRef = useRef<number | null>(null);
  // betting window timers
  const betIntervalRef = useRef<number | null>(null);
  const betTimeoutRef = useRef<number | null>(null);

  // helper: continuous bob animation for the ship
  const startBob = () => controls.start({ x: [0, 2, 0, -2, 0], y: [0, -3, 0, 3, 0], transition: { duration: 3.8, repeat: Infinity, ease: "easeInOut" } });

  // On crash, sink the ship only; keep ice intact on loss
  useEffect(() => {
    if (phase === "crashed") {
      controls.start({ y: 140, rotate: -22, opacity: 0.9, transition: { duration: 1.6, ease: "easeIn" } });
    }
  }, [phase, controls]);

  // After a round ends, immediately enter the 10s betting window
  useEffect(() => {
    if (restartTimeoutRef.current) {
      window.clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (phase === "crashed" || phase === "lifeboat") {
      startBettingPhase();
    }
    return () => {
      if (restartTimeoutRef.current) {
        window.clearTimeout(restartTimeoutRef.current);
        restartTimeoutRef.current = null;
      }
    };
  }, [phase]);

  // Auto-start on mount: begin the betting window when layout is ready
  const startedRef = useRef<boolean>(false);
  useEffect(() => {
    // Clear any persisted roundActive so hard refresh always starts a fresh round
    try { sessionStorage.setItem(SS_KEYS.roundActive, '0'); } catch {}
    const t = window.setTimeout(() => {
      if (ready && !startedRef.current && phaseRef.current === "idle") {
        startedRef.current = true;
        // auto-start betting window
        startBettingPhase();
      }
    }, 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to readiness becoming true
  useEffect(() => {
    if (ready && !startedRef.current && phaseRef.current === "idle") {
      startedRef.current = true;
      startBettingPhase();
    }
  }, [ready]);

  // Audio
  const audioCtxRef = useRef<AudioContext | null>(null);
  const beep = (freq = 880, time = 0.07, type: OscillatorType = "sine") => {
    if (muted) return;
    try {
      const ctx = audioCtxRef.current || new (window.AudioContext || (window as any).webkitAudioContext)();
      audioCtxRef.current = ctx;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type; o.frequency.value = freq; g.gain.value = 0.08; o.connect(g).connect(ctx.destination); o.start();
      setTimeout(() => { o.stop(); o.disconnect(); }, time * 1000);
    } catch {}
  };

  // Start only (no manual reset control path anymore)

  const clearBettingTimers = () => {
    if (betIntervalRef.current) { window.clearInterval(betIntervalRef.current); betIntervalRef.current = null; }
    if (betTimeoutRef.current) { window.clearTimeout(betTimeoutRef.current); betTimeoutRef.current = null; }
  };

  const startBettingPhase = () => {
    // Enter 5s betting window; allow adjusting bet
    stopLoop();
    clearBettingTimers();
    setPhase("betting");
    phaseRef.current = "betting";
    setHasCashed(false);
    setJoined(false);
    setActiveBet(null);
    setCountdown(5);
    setMessage("Place your bet. Round starts in 5s.");
    // tick countdown and update message
    betIntervalRef.current = window.setInterval(() => {
      setCountdown((c) => {
        const n = Math.max(0, c - 1);
        setMessage(`Place your bet. Round starts in ${n}s.`);
        return n;
      });
    }, 1000);
    // auto start after 5s
    betTimeoutRef.current = window.setTimeout(() => {
      clearBettingTimers();
      startRound();
    }, 5000);
  };

  const startRound = () => {
    // Enforce minimum stake and available balance
    const minStake = 1;
    if (balance < minStake) {
      setMessage("Insufficient balance. Add funds to play.");
      startBettingPhase();
      return;
    }
    // Determine stake: if user joined, use locked activeBet; else clamp current bet
    let stake = clamp(bet, minStake, balance);
    if (joinedRef.current && (activeBetRef.current ?? 0) > 0) {
      stake = clamp(activeBetRef.current, minStake, balance);
    }
    // Prevent re-entrancy/double start (e.g., StrictMode or rapid clicks)
    if (phaseRef.current === "running") return;
    // Ensure any existing loop is stopped before starting anew
    stopLoop();
    // Stop betting timers when the round starts
    clearBettingTimers();
    // start round

    // Cancel any scheduled auto-restart to avoid double start
    if (restartTimeoutRef.current) {
      window.clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }

    // Smoothly reset any existing ice first
    setObstacles((prev) => prev.map((o) => ({ ...o, state: "breaking" as const })));
    // Only remove previously breaking ice; do not wipe newly spawned ones
    window.setTimeout(() => {
      setObstacles((cur) => cur.filter((o) => o.state !== "breaking"));
    }, 650);

    // Unsink back to intact position, then begin (no reverse wiggle)
    controls
      .start({ y: 0, rotate: 0, opacity: 1, transition: { duration: 0.9, ease: [0.16, 1, 0.3, 1] } })
      .then(() => {
        setPhase("running");
        phaseRef.current = "running";
        setHasCashed(false);
        setCollected(1);
        setSafeHits(0);
        // If user joined, lock/deduct stake; otherwise no bet active this round
        if (joinedRef.current) {
          setActiveBet(stake);
          setBet(stake);
          setBalance((b) => b - stake);
        } else {
          setActiveBet(null);
        }
        setMessage("Sail on. Cash out before a crash.");
        // Reset planned multiplier sequence
        nextIndexRef.current = 1;
        plannedMultRef.current = 1;
        try {
          roundIdRef.current = (roundIdRef.current || 0) + 1;
          sessionStorage.setItem(SS_KEYS.roundId, String(roundIdRef.current));
          sessionStorage.setItem(SS_KEYS.roundActive, '1');
        } catch {}

        // Reset world scroll to 0 for the new round
        scrollRef.current = 0;
        if (laneScrollElRef.current) laneScrollElRef.current.style.transform = `translateX(0px)`;

        // Speed so both initial obstacles are visible and collide at 2s cadence
        const shipRight = shipBoundsRef.current.right;
        const laneW = laneWidthRef.current ?? 980;
        const margin = 12;
        speedRef.current = Math.max(60, (laneW - margin - shipRight) / 4);
        // Apply multiplier so movement speed increases, while spawn x stays tied to speed*HIT_INTERVAL
        speedRef.current *= SPEED_MULTIPLIER;

        // Initial two obstacles: exact TTC at 2s and 4s from now
        const baseX1 = spawnWorldXFor(1, shipBoundsRef.current.right, scrollRef.current);
        const baseX2 = spawnWorldXFor(2, shipBoundsRef.current.right, scrollRef.current);
        const m1 = planNextMultiplier();
        const m2 = planNextMultiplier();
        setObstacles([
          { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x: baseX1, width: 220, height: 110, multiplier: m1, iceberg: Math.random() < icebergChance(), state: "idle", bornAt: performance.now() },
          { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x: baseX2, width: 220, height: 110, multiplier: m2, iceberg: Math.random() < icebergChance(), state: "idle", bornAt: performance.now() },
        ]);

        // Gentle bob loop
        startBob();

        // rAF game loop
        lastTsRef.current = null;
        spawnAccumRef.current = 0;
        const loop = (ts: number) => {
          if (phaseRef.current !== "running") { rafRef.current = requestAnimationFrame(loop); return; }
          if (lastTsRef.current == null) lastTsRef.current = ts;
          const dt = Math.min(0.05, (ts - lastTsRef.current) / 1000);
          lastTsRef.current = ts;
          spawnAccumRef.current += dt;

          // Advance world scroll and apply transform (no React state updates for movement)
          scrollRef.current += speedRef.current * dt;
          if (laneScrollElRef.current) {
            laneScrollElRef.current.style.transform = `translateX(${-scrollRef.current}px)`;
          }

          const shipLeft = shipBoundsRef.current.left + SHIP_LEFT_PAD;
          const shipRightNow = shipBoundsRef.current.right + SHIP_RIGHT_PAD;
          const prev = obstaclesRef.current;
          let updated = prev;
          let needCommit = false;
          let crashedNow = false;
          let safeHitThisFrame = false;

          // Collisions based on worldX - scroll
          for (let i = 0; i < prev.length; i++) {
            const o = prev[i];
            if (crashedNow || safeHitThisFrame) break;
            if (o.state !== "idle") continue;
            const screenLeft = (o.x - scrollRef.current) + ICE_LEFT_PAD;
            const screenRight = (o.x - scrollRef.current) + o.width - ICE_RIGHT_PAD;
            const contact = screenLeft <= shipRightNow && screenRight >= shipLeft;
            const fresh = (ts - o.bornAt) < 250;
            if (!fresh && contact) {
              if (o.iceberg) {
                crashedNow = true;
                break;
              }
              // safe hit effects
              controls.start({ x: [0, 34, 0], y: [0, -6, 0], transition: { duration: 0.55, ease: "easeInOut" } }).then(() => startBob());
              beep(1200, 0.06, "square");
              setCollected(() => { const nv = o.multiplier; collectedRef.current = nv; return nv; });
              setSafeHits((h) => { const nh = h + 1; safeHitsRef.current = nh; return nh; });
              safeHitThisFrame = true;
              // mark obstacle as breaking
              updated = prev.map((p) => (p.id === o.id ? { ...p, state: "breaking" as const } : p));
              needCommit = true;
            }
          }

          // Crash outcome handling
          if (crashedNow) {
            if (Math.random() < 0.05) {
              setPhase("lifeboat");
              if (!hasCashedRef.current) {
                const payout = activeBetRef.current * collectedRef.current;
                setBalance((b) => b + payout);
              }
              setMessage("You hit a hidden iceberg… but escaped in lifeboats! Winnings granted.");
              beep(900, 0.12, "triangle");
            } else {
              setPhase("crashed");
              setMessage("Hidden iceberg! The voyage ends here.");
              beep(220, 0.18, "sawtooth");
            }
            stopLoop();
            if (needCommit) commitObstacles(updated);
            return;
          }

          // 3a) immediate replacement on safe hit (maintain <=2 idle)
          const idleCount = updated.filter((o) => o.state === "idle").length;
          let spawnedThisFrame = false;
          if (safeHitThisFrame && idleCount < 2) {
            const m = planNextMultiplier();
            const x = spawnWorldXFor(2, shipBoundsRef.current.right, scrollRef.current);
            updated = [...updated, { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x, width: 220, height: 110, multiplier: m, iceberg: Math.random() < icebergChance(), state: "idle", bornAt: ts }];
            spawnAccumRef.current = 0;
            spawnedThisFrame = true;
            needCommit = true;
          }

          // 3b) cadence spawns
          let idleNow = updated.filter((o) => o.state === "idle").length;
          while (!spawnedThisFrame && spawnAccumRef.current >= HIT_INTERVAL && idleNow < 2) {
            const m = planNextMultiplier();
            const x = spawnWorldXFor(2, shipBoundsRef.current.right, scrollRef.current);
            updated = [...updated, { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x, width: 220, height: 110, multiplier: m, iceberg: Math.random() < icebergChance(), state: "idle", bornAt: ts }];
            spawnAccumRef.current -= HIT_INTERVAL;
            spawnedThisFrame = true;
            needCommit = true;
            idleNow++;
          }

          // 4) schedule removal of breaking ice (dedup by id)
          updated.forEach((o) => {
            if (o.state === "breaking" && !removalScheduledRef.current.has(o.id)) {
              removalScheduledRef.current.add(o.id);
              window.setTimeout(() => {
                const next = obstaclesRef.current.filter((k) => k.id !== o.id);
                commitObstacles(next);
                removalScheduledRef.current.delete(o.id);
              }, 950);
            }
          });

          // 5) off-screen cull (no state change if none removed)
          const culled = updated.filter((o) => ((o.x - scrollRef.current) + o.width) > -40);
          if (culled.length !== updated.length) {
            updated = culled;
            needCommit = true;
          }

          if (needCommit) commitObstacles(updated);

          rafRef.current = requestAnimationFrame(loop);
        };

        rafRef.current = requestAnimationFrame(loop);
      });
  };

  // stop any running animation frame
  const stopLoop = () => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  const cashOutNow = () => {
    if (phaseRef.current !== "running") return;
    if (!joinedRef.current) return;
    if (hasCashedRef.current) return; // only once per round
    // cash-out allowed at any multiplier
    // Do NOT stop the game; simply grant payout and keep sailing
    const payout = activeBetRef.current * collectedRef.current;
    setBalance((b) => b + payout);
    setHasCashed(true);
    beep(1500, 0.1, "triangle");
    setMessage("Cashed out! Voyage continues.");
  };

  // Clean up
  useEffect(() => () => { stopLoop(); if (betIntervalRef.current) window.clearInterval(betIntervalRef.current); if (betTimeoutRef.current) window.clearTimeout(betTimeoutRef.current); }, []);

  // Measure lane width and ship bounds; mark layout as ready when both are known
  useEffect(() => {
    const measure = () => {
      const lane = laneElRef.current;
      if (lane) laneWidthRef.current = lane.clientWidth;
      const laneRect = lane?.getBoundingClientRect();
      const ship = shipElRef.current;
      const shipRect = ship?.getBoundingClientRect();
      if (laneRect && shipRect) {
        shipBoundsRef.current = {
          left: shipRect.left - laneRect.left,
          right: shipRect.right - laneRect.left,
        };
        // Mark measured ready when valid sizes are present
        if (shipRect.width > 0 && laneRect.width > 0) {
          measuredReadyRef.current = true;
          setReady(shipLoadedRef.current && measuredReadyRef.current);
        }
      }
    };
    // measure now and on next frame (after layout settles)
    measure();
    const r = requestAnimationFrame(measure);
    window.addEventListener("resize", measure);
    return () => { cancelAnimationFrame(r); window.removeEventListener("resize", measure); };
  }, []);

  // Keyboard shortcut: Space only cashes out when running and user joined; never starts rounds
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") { e.preventDefault(); if (phaseRef.current === "running" && joinedRef.current) cashOutNow(); }
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, []);

  const payoutPreview = useMemo(() => (joined && activeBet ? activeBet : 0) * collected, [joined, activeBet, collected]);

  // cancel a placed bet during betting window
  const cancelBet = () => {
    if (phaseRef.current !== "betting") return;
    if (!joinedRef.current) return;
    setJoined(false);
    setActiveBet(null);
    setMessage("Bet canceled. You can place a new bet before the round starts.");
  };

  // place a bet for the upcoming round during betting window
  const placeBet = () => {
    if (phaseRef.current !== "betting") return;
    const stake = clamp(bet, 1, balance);
    if (stake < 1) { setMessage("Insufficient balance to place a bet."); return; }
    setJoined(true);
    setActiveBet(stake);
    setBet(stake);
    setMessage(`Bet placed: ₾ ${stake.toFixed(2)} — starting soon...`);
  };

  // Helper: worldX spawn so contact at exactly k * HIT_INTERVAL seconds from now
  const spawnWorldXFor = (k: number, shipRightNow: number, currentScroll: number) => {
    // oLeft_screen at contact: (worldX - (scroll0 + speed*k*T)) + ICE_LEFT_PAD = shipRight
    // => worldX = shipRight - ICE_LEFT_PAD + scroll0 + speed*k*T
    return shipRightNow - ICE_LEFT_PAD + currentScroll + speedRef.current * (k * HIT_INTERVAL);
  };

  // ---------- Render ----------
  return (
    <div className="h-screen w-full bg-[#060816] text-white overflow-hidden relative flex flex-col">
      <NeonGlow />

      {/* Top HUD */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 pt-2">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-cyan-500/15 border border-cyan-400/40">
              <Anchor className="h-4 w-4 text-cyan-300" />
            </div>
            <div>
              <div className="text-base md:text-lg font-bold text-cyan-200">Cruise</div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="rounded-2xl border border-white/15 bg-white/5 px-3 py-1.5 backdrop-blur-md">
              <div className="text-[10px] uppercase tracking-widest text-white/60 leading-none">Balance</div>
              <div className="font-semibold text-sm md:text-base">₾ {balance.toFixed(2)}</div>
            </div>
            <NeonButton onClick={() => setMuted((m) => !m)} variant="ghost" className="flex items-center gap-2">
              {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}<span className="text-xs">{muted ? "Muted" : "Sound"}</span>
            </NeonButton>
          </div>
        </div>
      </div>

      {/* Ocean stage */}
      <div className="relative z-0 mt-2 shrink-0">
        <div className="mx-auto max-w-6xl px-4">
          <div ref={laneElRef} className="relative w-full overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-b from-[#0b1029] via-[#0a0f26] to-[#070b1d] h-[30vh] sm:h-[34vh] md:h-[38vh] lg:h-[380px]">
            {/* Horizon shimmer */}
            <div className="absolute top-16 left-0 right-0 h-0.5 bg-gradient-to-r from-transparent via-cyan-400/60 to-transparent blur-[1px]" />
            {/* Water lines */}
            <div className="absolute inset-0 opacity-30" aria-hidden>
              {Array.from({ length: 12 }).map((_, i) => (
                <motion.div key={i} className="absolute left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" style={{ top: `${20 + i * 28}px` }} animate={{ opacity: [0.1, 0.4, 0.1] }} transition={{ duration: 4 + i * 0.25, repeat: Infinity }} />
              ))}
            </div>

            {/* Ship (PNG) */}
            <motion.div
              ref={shipElRef}
              className="absolute bottom-29 drop-shadow-[0_0_18px_rgba(34,211,238,0.6)]"
              style={{ left: SHIP_OFFSET_X }}
              animate={controls}
            >
              <img
                src={shipPng}
                alt="Ship"
                width={330}
                height={64}
                className="select-none"
                draggable={false}
                onLoad={() => { shipLoadedRef.current = true; window.dispatchEvent(new Event('resize')); setReady(measuredReadyRef.current && shipLoadedRef.current); }}
              />
            </motion.div>

            {/* Lane: moving obstacles (scrolled via transform for performance) */}
            <div ref={laneScrollElRef} className="absolute inset-x-0 bottom-21 h-[110px] will-change-transform" style={{ transform: 'translateX(0px)' }}>
              {obstacles.map((o) => (
                <div key={o.id} className="absolute" style={{ left: o.x }}>
                  <IceBlock label={fmtMult(o.multiplier)} state={o.state === "breaking" ? "breaking" : "static"} />
                </div>
              ))}
            </div>

            {/* Global sea overlay across the lane to hide bases */}
            <div className="absolute inset-x-0 bottom-24 h-[110px] pointer-events-none">
              <svg viewBox="0 0 100 110" preserveAspectRatio="none" className="w-full h-full">
                <path d="M0 78 C15 74, 35 82, 50 78 C65 74, 85 82, 100 78 L100 110 L0 110 Z" fill="#071026" opacity="0.88" />
                <path d="M0 78 C15 74, 35 82, 50 78 C65 74, 85 82, 100 78" fill="none" stroke="#5ee6ff" strokeOpacity="0.35" strokeWidth="1.5" />
              </svg>
            </div>
            {/* Bottom filler to extend overlay to the very bottom without moving the stroke */}
            <div className="absolute inset-x-0 bottom-0 h-24 pointer-events-none" style={{ backgroundColor: "#071026", opacity: 0.88, marginBottom: "0.3px" }} />
          </div>
        </div>
      </div>

      {/* Stats + Controls */}
      <div className="relative z-10 mx-auto max-w-6xl px-4 py-2 flex-1 min-h-0 overflow-hidden">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 h-full">
          {/* Left: Round stats */}
          <div className="lg:col-span-3 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md h-full">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-white/60">Current Multiplier</div>
                <div className="text-3xl md:text-4xl font-black text-cyan-200 drop-shadow-[0_0_18px_rgba(34,211,238,0.45)] leading-tight">{fmtMult(collected)}</div>
              </div>
            </div>

            <NeonDivider />

            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-2xl border border-white/10 bg-[#0c122f]/60 p-3">
                <div className="text-[10px] uppercase tracking-widest text-white/60">Payout Preview</div>
                <div className="text-2xl font-semibold">₾ {payoutPreview.toFixed(2)}</div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-[#0c122f]/60 p-3">
                <div className="text-[10px] uppercase tracking-widest text-white/60">Safe Hits</div>
                <div className="text-2xl font-semibold text-cyan-200">{safeHits}</div>
              </div>
            </div>

            <div className="mt-3 text-sm text-white/70 min-h-[20px] leading-snug">{message}</div>

            {/* Outcome banners moved here */}
            <AnimatePresence>
              {phase === "cashed" && (
                <motion.div className="mt-3 rounded-2xl border border-emerald-400/50 bg-emerald-500/15 p-3 text-emerald-200" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                  <div className="flex items-center gap-2"><Trophy className="h-4 w-4" /> You cashed out with <span className="font-semibold">{fmtMult(collected)}</span> — payout ₾ {payoutPreview.toFixed(2)}</div>
                </motion.div>
              )}
              {phase === "crashed" && (
                <motion.div className="mt-3 rounded-2xl border border-fuchsia-400/50 bg-fuchsia-500/15 p-3 text-fuchsia-200" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                  <div className="flex items-center gap-2"><Zap className="h-4 w-4" /> Hidden iceberg. Better luck next time.</div>
                </motion.div>
              )}
              {phase === "lifeboat" && (
                <motion.div className="mt-3 rounded-2xl border border-cyan-400/50 bg-cyan-500/15 p-3 text-cyan-200" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}>
                  <div className="flex items-center gap-2"><ShipIcon className="h-4 w-4" /> Lifeboat miracle! You still got paid ₾ {payoutPreview.toFixed(2)} at {fmtMult(collected)}.</div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right: Controls */}
          <div className="lg:col-span-2 rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-md h-full">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-widest text-white/60">Controls</div>
              <HelpCircle className="h-4 w-4 text-white/30" />
            </div>

            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <label className="text-xs text-white/60">Bet Amount</label>
                <div className="mt-1 flex items-center gap-2">
                  <input type="number" min={1} step={1} className="w-full rounded-2xl bg-[#0b1029]/70 border border-white/15 px-4 py-2 outline-none focus:border-cyan-300/60 disabled:opacity-60" value={bet} onChange={(e) => setBet(clamp(Number(e.target.value || 0), 1, balance))} disabled={phase !== "betting" || joined} />
                  <NeonButton variant="ghost" onClick={() => setBet((b) => clamp(b * 2, 1, balance))} disabled={phase !== "betting" || joined}>x2</NeonButton>
                  <NeonButton variant="ghost" onClick={() => setBet((b) => Math.max(1, Math.floor(b / 2)))} disabled={phase !== "betting" || joined}>/2</NeonButton>
                </div>
              </div>

              <div className="col-span-2 flex items-center gap-2 mt-2">
                {/* Dynamic action button */}
                {phase === "betting" && (
                  !joined ? (
                    <NeonButton onClick={placeBet} className="flex-1 flex items-center justify-center gap-2" variant="primary">
                      <TimerReset className="h-4 w-4" /> Place Bet (₾ {bet.toFixed(2)}) — {Math.max(0, countdown)}s
                    </NeonButton>
                  ) : (
                    <NeonButton onClick={cancelBet} className="flex-1 flex items-center justify-center gap-2" variant="danger">
                      <TimerReset className="h-4 w-4" /> Cancel Bet — {Math.max(0, countdown)}s
                    </NeonButton>
                  )
                )}
                {phase === "running" && (
                  joined && !hasCashed ? (
                    <NeonButton onClick={cashOutNow} className="flex-1 flex items-center justify-center gap-2" variant="danger">
                      <TimerReset className="h-4 w-4" /> Cash Out — ₾ {payoutPreview.toFixed(2)}
                    </NeonButton>
                  ) : (
                    <NeonButton className="flex-1 flex items-center justify-center gap-2" variant="ghost" disabled>
                      <TimerReset className="h-4 w-4" /> Wait for next round
                    </NeonButton>
                  )
                )}
                {(phase === "crashed" || phase === "lifeboat" || phase === "idle") && (
                  <NeonButton className="flex-1 flex items-center justify-center gap-2" variant="ghost" disabled>
                    <TimerReset className="h-4 w-4" /> Wait for next round
                  </NeonButton>
                )}
              </div>

              <div className="col-span-2 grid grid-cols-3 gap-2 mt-2">
                <div className="rounded-2xl border border-white/10 bg-[#0c122f]/60 p-2.5 text-center">
                  <div className="text-[10px] uppercase tracking-widest text-white/50">Phase</div>
                  <div className="font-semibold text-white/90">
                    {phase === "idle" && "Idle"}
                    {phase === "betting" && "Betting"}
                    {phase === "running" && "Running"}
                    {phase === "cashed" && "Cashed Out"}
                    {phase === "crashed" && "Crashed"}
                    {phase === "lifeboat" && "Lifeboat!"}
                  </div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-[#0c122f]/60 p-2.5 text-center">
                  <div className="text-[10px] uppercase tracking-widest text-white/50">Hits</div>
                  <div className="font-semibold text-white/90">{safeHits}</div>
                </div>
                {/* Removed decision timer; rAF loop is continuous */}
              </div>
            </div>

            
          </div>
        </div>
      </div>

      
    </div>
  );
};

export default CruiseNeonCrash;
