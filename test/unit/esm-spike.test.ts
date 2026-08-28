import chalk from "chalk";
import { value } from "../fixtures/esm-spike/x.js";

describe("Jest + ESM spike", () => {
  it("imports a relative .js-extension module under NodeNext", () => {
    expect(value).toBe(42);
  });

  it("imports chalk v6, the usual ESM detonator", () => {
    expect(typeof chalk.red).toBe("function");
    expect(chalk.red("hello")).toEqual(expect.stringContaining("hello"));
  });
});
