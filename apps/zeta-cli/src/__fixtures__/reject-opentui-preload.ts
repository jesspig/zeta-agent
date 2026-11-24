Bun.plugin({
  name: "reject-opentui-in-headless",
  setup(build) {
    build.onResolve({ filter: /^@opentui\// }, () => {
      throw new Error("HEADLESS_IMPORTED_OPENTUI");
    });
  },
});
