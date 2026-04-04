// ============================================================
// Presence-Heater Recipe — external package
// ============================================================

// Minimal types for RecipeContext (injected at runtime by Sowel core)
interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): {
      name: string;
      type?: string;
      zoneId?: string;
      dataBindings: Array<{ alias: string }>;
      orderBindings: Array<{ alias: string; enumValues?: string[] }>;
    } | null;
    executeOrder(
      equipmentId: string,
      alias: string,
      value: unknown,
    ): Promise<{ success: boolean; error?: string }>;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  zoneAggregator: {
    getByZoneId(id: string): { motion: boolean; motionSensors: number } | null;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
  };
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
  };
  group?: string;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
  groups?: Record<string, string>;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  actions?: unknown[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(
    params: Record<string, unknown>,
    ctx: RecipeContext,
  ): { stop(): void; onAction?(action: string, payload?: Record<string, unknown>): void };
}

// ============================================================
// Helpers
// ============================================================

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((id): id is string => typeof id === "string");
  }
  if (typeof value === "string" && value.length > 0) {
    return value.split(",").filter(Boolean);
  }
  return [];
}

function isInTimeWindow(now: Date, startTime: string, endTime: string): boolean {
  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    // Same-day range (e.g., 06:00 to 08:00)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }
  // Overnight range (e.g., 22:00 to 06:00)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

// ============================================================
// Recipe Definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "presence-heater",
    name: "Presence Heater",
    description:
      "Switches electric heaters to comfort on motion, eco after absence timeout. Fil pilote convention: relay OFF = comfort, relay ON = eco.",

    slots: [
      {
        id: "zone",
        name: "Zone",
        description: "Zone to monitor for presence",
        type: "zone",
        required: true,
      },
      {
        id: "heaters",
        name: "Heaters",
        description: "Electric heater equipments (relay-controlled)",
        type: "equipment",
        required: true,
        list: true,
        constraints: { equipmentType: "heater" },
      },
      {
        id: "timeout",
        name: "Timeout",
        description: "Delay with no motion before switching to eco",
        type: "duration",
        required: true,
        defaultValue: "30m",
      },
      {
        id: "nightStart",
        name: "Night Start",
        description: "Start of forced eco window (HH:MM)",
        type: "time",
        required: false,
        group: "night",
      },
      {
        id: "nightEnd",
        name: "Night End",
        description: "End of forced eco window (HH:MM)",
        type: "time",
        required: false,
        group: "night",
      },
      {
        id: "maxOnDuration",
        name: "Max Comfort Duration",
        description: "Force eco after this duration even with continued motion (safety)",
        type: "duration",
        required: false,
      },
    ],

    i18n: {
      fr: {
        name: "Chauffage présence",
        description:
          "Passe les radiateurs électriques en confort sur mouvement, éco après un délai sans présence. Convention fil pilote : relais OFF = confort, relais ON = éco.",
        slots: {
          zone: { name: "Zone", description: "Zone à surveiller" },
          heaters: {
            name: "Radiateurs",
            description: "Radiateurs électriques (contrôlés par relais)",
          },
          timeout: { name: "Délai", description: "Délai sans mouvement avant passage en éco" },
          nightStart: {
            name: "Début nuit",
            description: "Début de la plage éco forcé (HH:MM)",
          },
          nightEnd: {
            name: "Fin nuit",
            description: "Fin de la plage éco forcé (HH:MM)",
          },
          maxOnDuration: {
            name: "Durée max confort",
            description: "Forcer éco après cette durée même si mouvement continu (sécurité)",
          },
        },
        groups: {
          night: "Nuit",
        },
      },
      en: {
        name: "Presence Heater",
        description:
          "Switches electric heaters to comfort on motion, eco after absence timeout. Fil pilote: relay OFF = comfort, relay ON = eco.",
        groups: {
          night: "Night",
        },
      },
    },

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      const { zone, timeout, maxOnDuration } = params;

      // Validate zone
      if (!zone || typeof zone !== "string") {
        throw new Error("Zone parameter is required");
      }
      const zoneObj = ctx.zoneManager.getById(zone);
      if (!zoneObj) {
        throw new Error(`Zone not found: ${zone}`);
      }
      const zoneData = ctx.zoneAggregator.getByZoneId(zone);
      if (zoneData && zoneData.motionSensors === 0) {
        ctx.log("Zone has no motion sensors — recipe will only work with night window", "warn");
      }

      // Validate heaters
      const heaterIds = normalizeStringArray(params.heaters);
      if (heaterIds.length === 0) {
        throw new Error("At least one heater is required");
      }
      for (const heaterId of heaterIds) {
        const equipment = ctx.equipmentManager.getByIdWithDetails(heaterId);
        if (!equipment) {
          throw new Error(`Heater equipment not found: ${heaterId}`);
        }
        if (equipment.type !== "heater") {
          throw new Error(`Equipment "${equipment.name}" is not a heater`);
        }
        const hasStateOrder = equipment.orderBindings.some((ob) => ob.alias === "state");
        if (!hasStateOrder) {
          throw new Error(`Heater "${equipment.name}" has no "state" order binding`);
        }
      }

      // Validate timeout
      ctx.helpers.parseDuration(timeout || "30m");

      // Validate night window
      const { nightStart: ns, nightEnd: ne } = params;
      const hasNightStart = ns !== undefined && ns !== null && ns !== "";
      const hasNightEnd = ne !== undefined && ne !== null && ne !== "";
      if (hasNightStart !== hasNightEnd) {
        throw new Error("nightStart and nightEnd must both be provided or both omitted");
      }
      if (hasNightStart && typeof ns === "string" && !/^\d{2}:\d{2}$/.test(ns)) {
        throw new Error("nightStart must be in HH:MM format");
      }
      if (hasNightEnd && typeof ne === "string" && !/^\d{2}:\d{2}$/.test(ne)) {
        throw new Error("nightEnd must be in HH:MM format");
      }

      // Validate maxOnDuration
      if (maxOnDuration !== undefined && maxOnDuration !== null && maxOnDuration !== "") {
        ctx.helpers.parseDuration(maxOnDuration);
      }
    },

    createInstance(params: Record<string, unknown>, ctx: RecipeContext) {
      const zoneId = params.zone as string;
      const heaterIds = normalizeStringArray(params.heaters);
      const timeoutMs = ctx.helpers.parseDuration(params.timeout || "30m");

      // Night window
      const nightStart =
        typeof params.nightStart === "string" && params.nightStart ? params.nightStart : null;
      const nightEnd =
        typeof params.nightEnd === "string" && params.nightEnd ? params.nightEnd : null;

      // Max on duration
      const maxOnDurationMs =
        params.maxOnDuration !== undefined &&
        params.maxOnDuration !== null &&
        params.maxOnDuration !== ""
          ? ctx.helpers.parseDuration(params.maxOnDuration)
          : null;

      // ── Runtime state (closure variables) ──────────────────
      let currentMode: "comfort" | "eco" = "eco";
      let overrideMode = false;
      let ecoTimer: ReturnType<typeof setTimeout> | null = null;
      let failsafeTimer: ReturnType<typeof setTimeout> | null = null;
      let nightCheckTimer: ReturnType<typeof setInterval> | null = null;
      let stateGraceUntil = 0;
      const unsubs: (() => void)[] = [];

      // Reset persisted state
      ctx.state.delete("overrideMode");

      // ── Night window helpers ───────────────────────────────

      function hasNightConfig(): boolean {
        return nightStart !== null && nightEnd !== null;
      }

      function isInNightWindow(): boolean {
        if (!hasNightConfig()) return false;
        return isInTimeWindow(new Date(), nightStart!, nightEnd!);
      }

      // ── Relay state helpers ────────────────────────────────

      // Fil pilote: relay OFF = comfort, relay ON = eco
      function isComfortState(value: unknown): boolean {
        const isOn = value === true || String(value).toUpperCase() === "ON";
        return !isOn; // comfort = relay OFF
      }

      function resolveEnumValue(heaterId: string, target: "on" | "off"): string {
        const equipment = ctx.equipmentManager.getByIdWithDetails(heaterId);
        const stateOrder = equipment?.orderBindings.find((ob) => ob.alias === "state");
        const match = stateOrder?.enumValues?.find((v) => v.toLowerCase() === target);
        return match ?? target.toUpperCase();
      }

      // ── Motion helper ──────────────────────────────────────

      function hasMotion(): boolean {
        const zoneData = ctx.zoneAggregator.getByZoneId(zoneId);
        return zoneData?.motion ?? false;
      }

      // ── Timer state persistence ────────────────────────────

      function persistTimerState(): void {
        const expiresAt = new Date(Date.now() + timeoutMs).toISOString();
        ctx.state.set("timerExpiresAt", expiresAt);
      }

      function clearTimerState(): void {
        ctx.state.delete("timerExpiresAt");
      }

      // ── Eco timer management ───────────────────────────────

      function cancelEcoTimer(): void {
        if (ecoTimer) {
          clearTimeout(ecoTimer);
          ecoTimer = null;
        }
      }

      function startEcoTimer(): void {
        cancelEcoTimer();
        ecoTimer = setTimeout(() => {
          ecoTimer = null;
          clearTimerState();
          setEco(`No motion for ${ctx.helpers.formatDuration(timeoutMs)}`);
        }, timeoutMs);
        persistTimerState();
      }

      function startEcoTimerForOverrideClear(): void {
        cancelEcoTimer();
        ecoTimer = setTimeout(() => {
          ecoTimer = null;
          clearTimerState();
          setEco(`No motion for ${ctx.helpers.formatDuration(timeoutMs)} — override cleared`);
        }, timeoutMs);
        persistTimerState();
      }

      // ── Failsafe timer management ─────────────────────────

      function cancelFailsafeTimer(): void {
        if (failsafeTimer) {
          clearTimeout(failsafeTimer);
          failsafeTimer = null;
          ctx.state.delete("failsafeExpiresAt");
        }
      }

      function startFailsafeTimer(): void {
        if (maxOnDurationMs === null) return;
        cancelFailsafeTimer();
        failsafeTimer = setTimeout(() => {
          failsafeTimer = null;
          ctx.state.delete("failsafeExpiresAt");
          cancelEcoTimer();
          clearTimerState();
          setEco(
            `Failsafe: forced eco after ${ctx.helpers.formatDuration(maxOnDurationMs)} max comfort duration`,
          );
        }, maxOnDurationMs);
        const expiresAt = new Date(Date.now() + maxOnDurationMs).toISOString();
        ctx.state.set("failsafeExpiresAt", expiresAt);
      }

      // ── Override management ────────────────────────────────

      function clearOverrideMode(): void {
        if (!overrideMode) return;
        overrideMode = false;
        ctx.state.delete("overrideMode");
      }

      // ── Actions ────────────────────────────────────────────

      // Fil pilote: comfort = relay OFF
      function setComfort(reason: string): void {
        currentMode = "comfort";
        ctx.state.set("currentMode", "comfort");
        stateGraceUntil = Date.now() + 5000;
        const comfortValue = "off" as const;
        for (const heaterId of heaterIds) {
          ctx.equipmentManager
            .executeOrder(heaterId, "state", resolveEnumValue(heaterId, comfortValue))
            .then((r) => {
              if (!r.success) ctx.log(`Heater ${heaterId} comfort FAILED: ${r.error}`, "error");
            })
            .catch((err) =>
              ctx.log(`Error setting heater to comfort: ${String(err)}`, "error"),
            );
        }
        ctx.log(`${reason} — heaters set to comfort`);
        startFailsafeTimer();
      }

      // Fil pilote: eco = relay ON
      function setEco(reason: string): void {
        currentMode = "eco";
        ctx.state.set("currentMode", "eco");
        stateGraceUntil = Date.now() + 5000;
        const ecoValue = "on" as const;
        for (const heaterId of heaterIds) {
          ctx.equipmentManager
            .executeOrder(heaterId, "state", resolveEnumValue(heaterId, ecoValue))
            .then((r) => {
              if (!r.success) ctx.log(`Heater ${heaterId} eco FAILED: ${r.error}`, "error");
            })
            .catch((err) => ctx.log(`Error setting heater to eco: ${String(err)}`, "error"));
        }
        clearOverrideMode();
        cancelFailsafeTimer();
        ctx.log(`${reason} — heaters set to eco`);
      }

      // ── Event handlers ─────────────────────────────────────

      function onZoneChanged(motion: boolean): void {
        // Override mode: recipe is suspended, only track room vacancy
        if (overrideMode) {
          if (motion) {
            cancelEcoTimer();
            clearTimerState();
          } else {
            startEcoTimerForOverrideClear();
          }
          return;
        }

        // Night window: force eco regardless of motion
        if (isInNightWindow()) {
          if (currentMode === "comfort") {
            cancelEcoTimer();
            clearTimerState();
            cancelFailsafeTimer();
            setEco("Night window — forced eco");
          }
          return;
        }

        if (motion) {
          cancelEcoTimer();
          clearTimerState();
          if (currentMode === "eco") {
            setComfort("Motion detected");
          }
        } else {
          if (currentMode === "comfort") {
            startEcoTimer();
          }
        }
      }

      function onHeaterStateChanged(value: unknown): void {
        if (overrideMode) return;
        if (Date.now() < stateGraceUntil) return;

        // Detect if the state change was unexpected (manual override)
        const isComfort = isComfortState(value);
        if (
          (currentMode === "comfort" && !isComfort) ||
          (currentMode === "eco" && isComfort)
        ) {
          overrideMode = true;
          ctx.state.set("overrideMode", true);
          ctx.log("Manual relay change detected — entering override mode");
        }
      }

      // ── Night transition check ─────────────────────────────

      function checkNightTransition(): void {
        if (overrideMode) return;

        const inNight = isInNightWindow();

        // Entering night window -> force eco
        if (inNight && currentMode === "comfort") {
          cancelEcoTimer();
          clearTimerState();
          cancelFailsafeTimer();
          setEco("Night window started — forced eco");
        }

        // Leaving night window -> resume based on motion
        if (!inNight && currentMode === "eco") {
          if (hasMotion()) {
            setComfort("Night window ended — motion present");
          }
        }
      }

      // ── Initial sync ───────────────────────────────────────

      function syncOnStart(): void {
        const zoneData = ctx.zoneAggregator.getByZoneId(zoneId);
        const motion = zoneData?.motion ?? false;

        if (isInNightWindow()) {
          setEco("Recipe activated — night window active");
        } else if (motion) {
          setComfort("Recipe activated — motion detected");
        } else {
          setEco("Recipe activated — no motion");
        }
      }

      // ── Subscribe to events ────────────────────────────────

      const unsubZone = ctx.eventBus.onType("zone.data.changed", (event) => {
        if (event.zoneId !== zoneId) return;
        onZoneChanged(
          (event.aggregatedData as Record<string, unknown>)?.motion as boolean,
        );
      });
      unsubs.push(unsubZone);

      const unsubState = ctx.eventBus.onType("equipment.data.changed", (event) => {
        if (!heaterIds.includes(event.equipmentId as string)) return;
        if (event.alias !== "state") return;
        onHeaterStateChanged(event.value);
      });
      unsubs.push(unsubState);

      // Night check timer (every 60s)
      if (hasNightConfig()) {
        nightCheckTimer = setInterval(() => {
          checkNightTransition();
        }, 60_000);
      }

      // Sync on start
      syncOnStart();

      // ── Return instance ────────────────────────────────────

      return {
        stop() {
          cancelEcoTimer();
          cancelFailsafeTimer();
          if (nightCheckTimer) {
            clearInterval(nightCheckTimer);
            nightCheckTimer = null;
          }
          for (const unsub of unsubs) {
            unsub();
          }
          unsubs.length = 0;
          overrideMode = false;
          stateGraceUntil = 0;
          ctx.state.delete("overrideMode");
          ctx.state.delete("timerExpiresAt");
          ctx.state.delete("failsafeExpiresAt");
          ctx.state.delete("currentMode");
        },
      };
    },
  };
}
