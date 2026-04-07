import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTrustScore, updateTrust, decayTrust, adjustedScore, detectCollusion } from "./trust-score.js";

describe("Trust Score Engine", () => {
  describe("createTrustScore", () => {
    it("starts at 0.50 (maximum uncertainty)", () => {
      const t = createTrustScore();
      assert.equal(t.score, 0.50);
      assert.equal(t.alpha, 1);
      assert.equal(t.beta, 1);
      assert.equal(t.deviation, 0.35);
    });
  });

  describe("updateTrust", () => {
    it("increases score on success", () => {
      const t = createTrustScore();
      const updated = updateTrust(t, "success", "medium", 0);
      assert.ok(updated.score > t.score, `Expected ${updated.score} > ${t.score}`);
    });

    it("decreases score on failure", () => {
      // Start with some successes first
      let t = createTrustScore();
      for (let i = 0; i < 10; i++) t = updateTrust(t, "success", "medium", i);
      const before = t.score;
      const after = updateTrust(t, "critical_failure", "medium", 10);
      assert.ok(after.score < before, `Expected ${after.score} < ${before}`);
    });

    it("honest_failure does NOT decrease score (neutral)", () => {
      const t = createTrustScore();
      const updated = updateTrust(t, "honest_failure", "medium", 0);
      assert.equal(updated.score, t.score, "Honest failure should be neutral");
    });

    it("false_success is penalized MORE than honest failure", () => {
      const t = createTrustScore();
      const honest = updateTrust(t, "honest_failure", "medium", 0);
      const falseClaim = updateTrust(t, "false_success", "medium", 0);
      assert.ok(honest.score > falseClaim.score,
        `Honest (${honest.score}) should be higher than false claim (${falseClaim.score})`);
    });

    it("EVE diminishing returns: gains shrink at high trust", () => {
      // Low trust agent
      let low = createTrustScore();
      const lowGain = updateTrust(low, "success", "medium", 0).score - low.score;

      // High trust agent
      let high = createTrustScore();
      for (let i = 0; i < 100; i++) high = updateTrust(high, "success", "medium", i);
      const highGain = updateTrust(high, "success", "medium", 100).score - high.score;

      assert.ok(lowGain > highGain,
        `Low-trust gain (${lowGain.toFixed(4)}) should be > high-trust gain (${highGain.toFixed(4)})`);
    });

    it("hard tasks earn more than easy tasks", () => {
      const t = createTrustScore();
      const easy = updateTrust(t, "success", "easy", 0);
      const hard = updateTrust(t, "success", "hard", 0);
      assert.ok(hard.score > easy.score,
        `Hard success (${hard.score}) should give more trust than easy (${easy.score})`);
    });

    it("K-factor decreases with agent age (stabilization)", () => {
      const t = createTrustScore();
      const young = updateTrust(t, "success", "medium", 5);   // K=0.040
      const old = updateTrust(t, "success", "medium", 500);   // K=0.016
      assert.ok(young.score > old.score,
        `Young agent gain (${young.score}) should be > old agent gain (${old.score})`);
    });
  });

  describe("decayTrust (audit fix H-2)", () => {
    it("actually changes the trust score (not just deviation)", () => {
      let t = createTrustScore();
      // Build up to high trust
      for (let i = 0; i < 50; i++) t = updateTrust(t, "success", "medium", i);
      const before = t.score;
      assert.ok(before > 0.7, `Should have high trust: ${before}`);

      const after = decayTrust(t, 30); // 30 days inactive
      assert.ok(after.score < before,
        `Decay MUST reduce score: ${after.score} should be < ${before}`);
    });

    it("shifts score toward 0.5 prior (not toward 0)", () => {
      let t = createTrustScore();
      for (let i = 0; i < 50; i++) t = updateTrust(t, "success", "medium", i);
      const before = t.score;

      const after90 = decayTrust(t, 90);
      // Score should move TOWARD 0.5 (not away from it, and not stay the same)
      const distBefore = Math.abs(before - 0.5);
      const distAfter = Math.abs(after90.score - 0.5);
      assert.ok(distAfter < distBefore,
        `Score should be closer to 0.5 after decay: before=${before.toFixed(3)}, after=${after90.score.toFixed(3)}`);
    });

    it("increases deviation (more uncertain over time)", () => {
      const t = createTrustScore();
      const after = decayTrust(t, 30);
      assert.ok(after.deviation >= t.deviation,
        `Deviation should increase: ${after.deviation} >= ${t.deviation}`);
    });

    it("no decay for active agents (< 1 day)", () => {
      const t = createTrustScore();
      const same = decayTrust(t, 0.5);
      assert.equal(same.score, t.score);
    });
  });

  describe("adjustedScore (gaming detection)", () => {
    it("penalizes difficulty avoidance", () => {
      const raw = 0.90;
      const gaming = adjustedScore(raw, {
        difficultyAvoidance: 0.8, // Avoids 80% of hard tasks
        outputDiversity: 0.5,
        refusalRate: 0.1,
        attemptRate: 0.4, // Only accepts 40% of tasks
        canaryScoreGap: 0,
      });
      assert.ok(gaming < raw,
        `Adjusted score (${gaming}) should be < raw (${raw}) for gaming agent`);
    });

    it("rewards high attempt rate", () => {
      const raw = 0.80;
      const diligent = adjustedScore(raw, {
        difficultyAvoidance: 0.2,
        outputDiversity: 0.8,
        refusalRate: 0.05,
        attemptRate: 0.95, // Accepts 95% of tasks
        canaryScoreGap: 0,
      });
      assert.ok(diligent > raw,
        `Adjusted score (${diligent}) should be > raw (${raw}) for diligent agent`);
    });
  });

  describe("detectCollusion", () => {
    it("flags high correlation between evaluators", () => {
      const a = [9, 8, 9, 10, 8, 9, 9, 10, 8, 9];
      const b = [9, 8, 9, 10, 8, 9, 9, 10, 8, 9]; // Identical
      const result = detectCollusion(a, b, true);
      assert.ok(result.risk > 0.5, `Collusion risk should be high: ${result.risk}`);
      assert.ok(result.flags.length >= 2, `Should have multiple flags: ${result.flags}`);
    });

    it("does not flag independent evaluators", () => {
      const a = [9, 5, 8, 3, 7, 6, 9, 4, 8, 7];
      const b = [4, 8, 6, 9, 3, 7, 5, 8, 4, 6]; // Different pattern
      const result = detectCollusion(a, b, false);
      assert.ok(result.risk < 0.3, `Collusion risk should be low: ${result.risk}`);
    });

    it("needs minimum 5 evaluations", () => {
      const result = detectCollusion([9, 9], [9, 9], true);
      assert.equal(result.risk, 0, "Not enough data");
    });
  });
});
