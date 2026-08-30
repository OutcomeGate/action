export function decideGate(scenarios, gate) {
    const passed = scenarios.filter((scenario) => scenario.verdict === "pass").length;
    const blocked = scenarios.filter((scenario) => scenario.verdict === "block").length;
    const indeterminate = scenarios.filter((scenario) => scenario.verdict === "indeterminate").length;
    const total = scenarios.length;
    const passRate = total === 0 ? 0 : passed / total;
    if (blocked > 0) {
        return {
            verdict: "block",
            reasons: [
                `${blocked} scenario(s) were blocked`,
                ...(indeterminate > 0
                    ? [`${indeterminate} additional scenario(s) were indeterminate`]
                    : []),
            ],
            passed,
            blocked,
            indeterminate,
            total,
            passRate,
        };
    }
    if (indeterminate > 0) {
        return {
            verdict: "indeterminate",
            reasons: [`${indeterminate} scenario(s) were indeterminate`],
            passed,
            blocked,
            indeterminate,
            total,
            passRate,
        };
    }
    if (passRate < gate.minPassRate) {
        return {
            verdict: "block",
            reasons: [
                `pass rate ${(passRate * 100).toFixed(1)}% is below the required ${(gate.minPassRate * 100).toFixed(1)}%`,
            ],
            passed,
            blocked,
            indeterminate,
            total,
            passRate,
        };
    }
    return {
        verdict: "pass",
        reasons: [
            `pass rate ${(passRate * 100).toFixed(1)}% meets the required ${(gate.minPassRate * 100).toFixed(1)}%`,
        ],
        passed,
        blocked,
        indeterminate,
        total,
        passRate,
    };
}
