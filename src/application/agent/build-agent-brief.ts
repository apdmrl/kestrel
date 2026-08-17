import type { AgentBrief } from "../../domain/agent/agent-brief.js";
import type { Mission } from "../../domain/mission/mission.js";
import { policyFor } from "../../domain/policy/policies.js";
import type { Clock } from "../../ports/clock.js";

export interface BuildAgentBriefInput {
  readonly mission: Mission;
  readonly hypothesis?: string;
}

const GENERAL_CONSTRAINTS: readonly string[] = [
  "Clone upstream only; do not fork, push, or open pull requests.",
  "Do not install repository dependencies or run repository builds/tests.",
  "Keep Kestrel metadata outside the cloned repository.",
  "Do not modify files outside the repository working tree.",
];

const GUIDED_BEHAVIOR: readonly string[] = [
  "State your hypothesis before acting.",
  "Reflect on what you learn as you investigate.",
];

const EXPERT_BEHAVIOR: readonly string[] = [
  "Proceed directly to the root cause with concise engineering reasoning.",
];

function objectiveFor(mission: Mission): string {
  const repository = mission.challengeSnapshot.repository;
  const name = repository.owner + "/" + repository.name;
  switch (mission.challengeSnapshot.type) {
    case "BUG_FIX":
      return "Resolve the reported bug in " + name;
    case "TESTING":
      return "Add meaningful test coverage to " + name;
    case "DOCUMENTATION":
      return "Improve the documentation for " + name;
  }
}

/** Deterministically build a structured AgentBrief from Mission and policy data. */
export function buildAgentBrief(clock: Clock, input: BuildAgentBriefInput): AgentBrief {
  const mission = input.mission;
  const policy = policyFor(mission.challengeSnapshot.type);
  const guided = mission.acceptanceContext.mode === "GUIDED";

  const investigationGoals = [
    ...policy.agentBriefPolicy.investigationGoals,
    ...(guided ? ["Form a hypothesis and test it"] : []),
  ];

  const repositoryInstructions = [
    "This repository was cloned from upstream: " + mission.challengeSnapshot.source.canonicalUrl,
    "Repository: " +
      mission.challengeSnapshot.repository.owner +
      "/" +
      mission.challengeSnapshot.repository.name +
      " (issue #" +
      mission.challengeSnapshot.source.issueNumber +
      ")",
  ];

  return {
    schemaVersion: 1,
    policyVersion: policy.version,
    generatedAt: clock.now(),
    missionId: mission.id,
    mode: mission.acceptanceContext.mode,
    missionType: mission.challengeSnapshot.type,
    repository: mission.challengeSnapshot.repository,
    objective: objectiveFor(mission),
    challengeTitle: mission.challengeSnapshot.title,
    challengeDescription: mission.challengeSnapshot.description,
    investigationGoals,
    workflow: [...policy.agentBriefPolicy.workflow],
    constraints: GENERAL_CONSTRAINTS,
    verificationExpectations: [...policy.agentBriefPolicy.verificationExpectations],
    repositoryInstructions,
    developerHypothesis: input.hypothesis,
    agentBehavior: guided ? GUIDED_BEHAVIOR : EXPERT_BEHAVIOR,
    riskNotes: [...policy.agentBriefPolicy.riskNotes],
  };
}
