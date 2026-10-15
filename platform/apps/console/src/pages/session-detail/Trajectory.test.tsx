import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { Trajectory } from "../../lib/trajectory";
import {
  TrajectoryOutcomeChip,
  TrajectoryRewardChip,
  TrajectoryViewerModal,
} from "./Trajectory";

function trajectory(overrides: Partial<Trajectory> = {}): Trajectory {
  return {
    schema_version: "oma.trajectory.v1",
    trajectory_id: "traj_1",
    session_id: "sess_1",
    agent_config: {},
    environment_config: {},
    model: { id: "model", provider: "provider" },
    started_at: "2026-10-15T09:00:00.000Z",
    outcome: "success",
    events: [],
    summary: {
      num_events: 0,
      num_turns: 0,
      num_tool_calls: 0,
      num_tool_errors: 0,
      num_threads: 1,
      duration_ms: 0,
      token_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    },
    ...overrides,
  };
}

describe("TrajectoryOutcomeChip", () => {
  it("называет итог по-русски, а не сырым значением", () => {
    render(<TrajectoryOutcomeChip trajectory={trajectory({ outcome: "failure" })} />);

    expect(screen.getByText("Итог: неудача")).toBeInTheDocument();
    expect(screen.queryByText(/failure/)).toBeNull();
  });

  it("не рисуется, пока агент работает или траектория не готова", () => {
    const { container, rerender } = render(
      <TrajectoryOutcomeChip trajectory={trajectory({ outcome: "running" })} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<TrajectoryOutcomeChip trajectory="loading" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("TrajectoryRewardChip", () => {
  it("пишет «пройдено» и «не пройдено» вместо PASS и FAIL", () => {
    const { rerender } = render(
      <TrajectoryRewardChip
        trajectory={trajectory({ reward: { raw_rewards: {}, final_reward: 1 } })}
      />,
    );
    expect(screen.getByText("Оценка: пройдено")).toBeInTheDocument();

    rerender(
      <TrajectoryRewardChip
        trajectory={trajectory({ reward: { raw_rewards: {}, final_reward: 0 } })}
      />,
    );
    expect(screen.getByText("Оценка: не пройдено")).toBeInTheDocument();
  });

  it("ставит десятичную запятую в промежуточной оценке", () => {
    render(
      <TrajectoryRewardChip
        trajectory={trajectory({ reward: { raw_rewards: {}, final_reward: 0.42 } })}
      />,
    );

    expect(screen.getByText("Оценка: 0,42")).toBeInTheDocument();
  });

  it("скрыта, когда проверяющий ещё не выдал оценку", () => {
    const { container } = render(<TrajectoryRewardChip trajectory={trajectory()} />);

    expect(container).toBeEmptyDOMElement();
  });
});

describe("TrajectoryViewerModal", () => {
  it("при ошибке объясняет причину по-русски и оставляет скачивание недоступным", () => {
    render(
      <TrajectoryViewerModal open onClose={() => {}} sessionId="sess_1" trajectory="error" />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Траектория недоступна");
    expect(screen.getByRole("button", { name: "Скачать JSON" })).toBeDisabled();
    // Крестик окна и «Закрыть» в подвале: обе кнопки доступны.
    const closers = screen.getAllByRole("button", { name: "Закрыть" });
    expect(closers.length).toBeGreaterThanOrEqual(1);
    for (const closer of closers) expect(closer).toBeEnabled();
  });

  it("над JSON стоят итог и оценка траектории: в шапке сессии им места нет", () => {
    render(
      <TrajectoryViewerModal
        open
        onClose={() => {}}
        sessionId="sess_1"
        trajectory={trajectory({ outcome: "failure", reward: { raw_rewards: {}, final_reward: 1 } })}
      />,
    );

    expect(screen.getByText("Итог: неудача")).toBeInTheDocument();
    expect(screen.getByText("Оценка: пройдено")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Скачать JSON" })).toBeEnabled();
  });

  it("пока траектория грузится, чипов нет, а скачивание недоступно", () => {
    render(
      <TrajectoryViewerModal open onClose={() => {}} sessionId="sess_1" trajectory="loading" />,
    );

    expect(screen.getByText("Загрузка траектории…")).toBeInTheDocument();
    expect(screen.queryByText(/Итог:/)).toBeNull();
    expect(screen.getByRole("button", { name: "Скачать JSON" })).toBeDisabled();
  });
});
