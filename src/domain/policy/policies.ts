import type { ChallengeType } from "../challenge/challenge.js";
import type { MissionTypePolicy } from "./mission-type-policy.js";
import { bugFixPolicy } from "./bug-fix-policy.js";
import { documentationPolicy } from "./documentation-policy.js";
import { testingPolicy } from "./testing-policy.js";

const POLICIES: Record<ChallengeType, MissionTypePolicy> = {
  BUG_FIX: bugFixPolicy,
  TESTING: testingPolicy,
  DOCUMENTATION: documentationPolicy,
};

export function policyFor(type: ChallengeType): MissionTypePolicy {
  return POLICIES[type];
}
