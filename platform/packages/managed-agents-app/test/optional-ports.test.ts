// Optional Ports: a module may use a Port when the app has one and still
// start without it (docs/plans/crud.md, A15: the dependency check).
import { describe, expect, it } from "vitest";
import {
  AppCompositionError,
  bindPort,
  createApp,
  createPortToken,
  defineAppModule,
  providePort,
} from "../src/index";

const extraPort = createPortToken<{ value: string }>("test.extra");
const servicePort = createPortToken<{ read(): string }>("test.service");

const serviceModule = defineAppModule({
  name: "service",
  provides: [servicePort],
  optional: [extraPort],
  setup({ optionalPort }) {
    const extra = optionalPort(extraPort);
    return {
      ports: [bindPort(servicePort, { read: () => extra?.value ?? "none" })],
    };
  },
});

describe("optional Ports", () => {
  it("gives undefined when no module provides the Port", () => {
    const app = createApp({ modules: [serviceModule] });
    expect(app.port(servicePort).read()).toBe("none");
  });

  it("orders the provider first when it exists", () => {
    const app = createApp({
      modules: [serviceModule, providePort(extraPort, { value: "here" })],
    });
    expect(app.port(servicePort).read()).toBe("here");
  });

  it("still refuses an undeclared Port", () => {
    const sneaky = defineAppModule({
      name: "sneaky",
      provides: [servicePort],
      setup({ optionalPort }) {
        optionalPort(extraPort);
        return { ports: [bindPort(servicePort, { read: () => "x" })] };
      },
    });
    expect(() => createApp({ modules: [sneaky, providePort(extraPort, { value: "here" })] }))
      .toThrow(AppCompositionError);
  });
});
