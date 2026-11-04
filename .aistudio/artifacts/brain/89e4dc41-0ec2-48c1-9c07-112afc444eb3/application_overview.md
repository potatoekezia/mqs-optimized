# Monster Quiz Solver — Application Overview & Architecture

## 1. What the Application Does

**Monster Quiz Solver** is a real-time, mobile-friendly visual puzzle solver and collaborative team tool designed to solve in-game "Monster Quizzes." In a typical quiz screenshot, the game presents **3 Target Monsters** (top row, 2D portraits: `T1`, `T2`, `T3`) and **4 Answer Choices** (bottom row, 3D isometric monster sprites: `A1`, `A2`, `A3`, `A4`). The player must determine the exact 3-digit sequence (e.g., `241`) that maps each of the 3 target portraits to its corresponding answer choice without duplicates.

Because 2D portraits and 3D rotated sprites look structurally different, the application combines **local computer vision** (multi-orientation Perceptual Hashing + RGB Color Signatures + Global Combinatorial Assignment) with a **load-balanced Gemini AI vision fallback**, backed by a **cloud-synced Monster Dictionary** shared across 20–50 concurrent users via Firebase Firestore.

---

## 2. How It Works (The Hybrid Solving Pipeline)

When a user selects a quiz screenshot and clicks **SOLVE**, `runPipeline()` executes a multi-stage hybrid workflow:

### Stage 1: Calibrated Circle Cropping (`cropManualCircles`)
1. The uploaded screenshot is loaded onto an HTML5 `<canvas>`.
2. Using configurable circle coordinates (`circleConfig`), the app crops circular regions (`120×120` px) for the **3 Targets (`T1–T3`)** and **4 Answers (`A1–A4`)**.

### Stage 2: Feature Extraction (`computeMultiOrientationPHashes` & `computeColorSignature`)
1. **63-bit DCT Perceptual Hash (pHash):**
   - Each circular crop is downscaled to `32×32` grayscale pixels.
   - A 2D **Discrete Cosine Transform (DCT)** (`applyDCT`) extracts frequency components.
   - The top-left `8×8` low-frequency block (excluding the DC component at `(0,0)`) yields 63 values, which are thresholded against their mean to produce a 63-bit binary hash string.
2. **Multi-Orientation Invariance:**
   - Because 3D sprites may appear rotated or flipped, the solver generates hashes across 5 orientations (`0°`, `90°`, `180°`, `270°`, and `horizontal flip`) and caches features in `smartFeatureCache`.
3. **RGB Color Signature:**
   - A `16×16` downsample computes the mean non-transparent `(R, G, B)` color vector (`computeColorSignature`) and measures Euclidean color distance (`compareColors`).

### Stage 3: Dictionary Matching & Score Matrix Construction
1. Each target crop (`T1–T3`) is compared against all entries in the **Monster Dictionary** using Hamming distance similarity (`compareMultiHashes`).
2. Once a target monster is identified above the confidence threshold:
   - **Primary Match (85% pHash + 15% Color):** Compares the 4 current quiz answer choices (`A1–A4`) against the monster's saved historical 3D answer variants.
   - **Secondary Hint (Capped at 65%):** Compares answer choices directly against the 2D target portrait at a discount so it never falsely triggers a local match on its own, but still aids tie-breaking.
3. This builds a `3×4` **Score Matrix** (`scoreMatrix[targetIndex][answerIndex]`).

### Stage 4: Global 1-to-1 Combinatorial Assignment (`getOptimalAssignment`)
- Since no two targets can share the same answer choice, the solver evaluates all $4P3 = 24$ valid non-repeating permutations (`[a0, a1, a2]`) and selects the permutation that maximizes the total similarity score.
- **Fast Path (100% Local Solve):** If all 3 targets in the optimal permutation exceed the confidence threshold (default `75%`) and match known answer variants, the solver immediately outputs the 3-digit result (`Solved via pHash`) in milliseconds without calling any external API.

### Stage 5: Hybrid Lock + Gemini Vision AI Fallback (`callGeminiForPuzzle`)
- If any target lacks a saved answer variant or falls below the confidence threshold:
  1. **Target Locking:** Unambiguous targets (`score ≥ 78%` with at least a `10%` lead over the runner-up) are **locked** so the AI cannot overwrite them.
  2. **Clean Grid Synthesis (`createCleanQuizGrid`):** The app renders a clean `440×220` composite canvas displaying labeled `Target 1–3` on row 1 and `Choice 1–4` on row 2.
  3. **Load-Balanced API Request:** The composite image, locked constraints, and local pHash hints are sent to `/api/gemini/solve` using a key selected by the **Least-Loaded Round-Robin Rotator**.
  4. **Zero-Duplicate Reconciliation:** The returned AI digits are merged with locked pHash picks and remaining optimal permutations to guarantee a valid 3-digit non-repeating code (e.g., `Hybrid (2 pHash locked + Gemini)`).

---

## 3. Core Functionalities & UI Tabs

The frontend is a single-page application (`index.html`) organized into 4 primary navigation tabs and specialized modal workflows:

### 1. Solver Tab (`#tab-solver`)
- **One-Tap Image Pick & Solve:** Upload or paste a quiz screenshot, preview calibrated target/answer overlay circles in real time, and run the solver pipeline.
- **Interactive Result Display:** Displays the 3-digit answer (`#result-numbers`) in large monospace typography. Users can manually edit digits (`contenteditable`), and the status badge dynamically validates whether the code is `COMPLETE`, `INCOMPLETE`, or `INVALID` (contains duplicate digits).
- **Confidence Threshold Slider:** Adjusts the minimum similarity required (`50%–95%`, default `75%`) for local dictionary solving.
- **Collapsible Debug Panel:** Displays real-time pipeline telemetry, top-3 monster matches per target, and multi-rotation score arrays.

### 2. Dictionary Tab (`#tab-dictionary`)
- **Monster & Variant Repository:** Displays every cataloged monster, its 2D target portrait, editable monster name, and all associated 3D answer sprite variants.
- **Single Screenshot Entry Builder:** Upload a full screenshot, click a target circle (or select an existing monster from the horizontal wheel picker), and click answer circles to append new 3D sprite variants.
- **Smart Non-AI Match Suggestion:** Automatically runs local pHash + color matching when adding answers to suggest which existing monster the variant belongs to.
- **Batch Upload & Dating-App Card Stack (`#batch-modal`):**
  - Upload dozens of screenshots simultaneously.
  - Automatically matches answers to targets and presents a swipe/confirm card stack (`Confirm`, `Edit`, `Skip`, `Discard`) showing `A1–A4` mapped to their detected monsters and whether each sprite variant is `In Dict` or `NEW`.
- **Screenshot & Duplicate Audits:**
  - **Screenshot Audit Warning (`checkScreenshotAudit`):** Computes a structural file signature (`pHash + dimensions + byte size`) to warn users if a screenshot was already uploaded previously.
  - **Potential Duplicates Audit Panel (`openDuplicatesPanel`):** Scans all monster variants for near-identical sprites (`≥90%` similarity) or cross-monster collisions so users can merge or prune redundant sprites.
- **JSON Import / Export:** Full backup and restore of the monster dictionary.

### 3. Solver History & Analytics Tab (`#tab-history`)
- **Cross-User Solve Log:** Records every solved quiz with timestamp (formatted in Philippine Time, `UTC+8`), solver username, 3-digit result, solve duration, engine source (`pHash`, `Hybrid`, `Gemini`), and interactive `56×56` zoomed crop previews.
- **Next Quiz Arrival & Spawn Predictor (`updateNextQuizArrivalPrediction`):**
  - Analyzes historical solve intervals globally and per-user to calculate average spawn intervals, interval regularity, estimated arrival time (`PHT`), and a live countdown timer (`--:--`).
- **Daily Quiz Quota Tracker (`updateDailyQuotaTracker`):**
  - Tracks progress toward the daily target of **3 Quizzes / Day** per solver with visual 3-segment checklists and daily breakdown cards.
- **Answer Choice Distribution & Storage Savings:**
  - Visualizes frequency distributions across `A1`, `A2`, `A3`, and `A4` (`300%` total across 3 targets).
  - **Automated 24h Image Pruning (`pruneSolverHistory`):** Preserves historical text logs indefinitely for analytics while automatically stripping heavy base64 crop images after 24 hours to keep Firestore and `localStorage` fast and within quota.

### 4. Settings Tab (`#tab-settings`)
- **User Profile:** Browser-persisted username tag attached to history logs and webhook alerts.
- **Interactive Circle Position Calibrator (`#setup-overlay`):**
  - Drag-and-drop or fine-step (`dx/dy` arrow keys + radius sliders) calibration for `T1–T3` and `A1–A4` markers over a sample screenshot, with live circular crop preview and JSON import/export.
  - Includes **Rebuild Dictionary Hashes** to re-crop and re-hash entries if screen coordinates change.
- **Firebase Cloud Configuration:**
  - Live connection status indicator, custom Firebase credential inputs, config import/export, and a **Compress & Repair Oversized Database Entries** utility (`manualCompressDictionaryDatabase`) that shrinks bloated sprites down to lightweight `~2KB` JPEGs to prevent Firestore 1MB document limit errors.
- **Gemini API Key Pool & Load Balancer:**
  - Manage a shared pool of Gemini API keys synced across all connected devices.
  - Tracks per-key rolling 60-second Request-Per-Minute (`15 RPM` free-tier limit) capacity, cooldown timers on `429` rate limits, online key verification (`/api/gemini/verify-key`), and cloud-synced solve counters.
- **Webhook Notifications:**
  - Sends rich Discord/Slack embeds (with Philippine Time timestamps, solver name, 3-digit code, and solve duration) when a quiz is **Started** or **Solved**, using direct client delivery with automatic fallback to `/api/webhook/proxy`.
- **Anti-Stuck Timers:**
  - **Auto Refresh Solver:** Automatically resets the solver screen after a configurable delay so old screenshots aren't left on screen.
  - **Auto Revert to Solver Tab:** Returns idle users from History/Dictionary/Settings back to the Solver tab (minimum 5s guard to prevent soft-locking).

---

## 4. System Architecture & Components

| Component | File / Location | Role & Responsibilities |
| :--- | :--- | :--- |
| **Frontend SPA & Vision Engine** | `/index.html` | Contains the UI layout, CSS styling, HTML5 Canvas cropping, 2D DCT pHash algorithm, color signature matcher, combinatorial solver, analytics predictor, and Firebase real-time listeners. |
| **Express + Vite Backend** | `/server.ts` | Serves the Vite SPA on port `3000` (`0.0.0.0`) and provides API proxy routes for Gemini AI, shared fallback history, and CORS-free webhook delivery. |
| **Gemini API Proxy & Verifier** | `/server.ts` (`/api/gemini/*`) | `/api/gemini/verify-key` validates API keys against Google Generative Language API; `/api/gemini/solve` executes vision prompts with automatic model fallback (`gemini-3.8-flash` → `gemini-3.1-flash-lite` → `gemini-flash-latest`); `/api/gemini/stats` tracks aggregate solves. |
| **Shared History Fallback** | `/server.ts` (`/api/history`) & `/solver-history.json` | Persists and prunes 24-hour solve history on the server filesystem so history syncs even if Firebase is temporarily offline. |
| **Webhook Proxy** | `/server.ts` (`/api/webhook/proxy`) | Relays POST payloads to Discord/Slack webhook URLs if browser CORS blocks direct client-side delivery. |
| **Cloud Database & Sync** | `/firebase-applet-config.json` & `/firestore.rules` | Configures Firebase anonymous authentication and Firestore collections (`dictionary`, `solver_history`, `screenshots`, and `config/*` for `geminiKeys`, `appSettings`, `screenshotAudit`, and `ignoredDuplicates`). |
| **Load Testing Suite** | `/scripts/load-test.cjs` | Simulates concurrent multi-user load against the server endpoints. |

---

## 5. Performance & Anti-Lag Optimizations

1. **In-Memory Feature Caching (`smartFeatureCache` & `dictFeatureIndex`):** Multi-orientation DCT hashes and RGB signatures are computed once per image/entry and cached in memory, eliminating redundant `<canvas>` pixel reads during batch matching and solver runs.
2. **Pending-Write Snapshot Filtering:** Firestore `onSnapshot` listeners check `snapshot.metadata.hasPendingWrites` to ignore local echo events, preventing recursive write loops across connected devices.
3. **Automatic Sprite Compression (`compressImage` & `compressCircleCrop`):** Dictionary variants are compressed to `80×80` JPEG (`0.8` quality) and history crops to `56×56`, keeping Firestore payloads small and UI rendering smooth.
4. **24-Hour Image Pruning:** Keeps historical metadata for long-term spawn predictions while stripping old base64 thumbnails from memory and storage.
