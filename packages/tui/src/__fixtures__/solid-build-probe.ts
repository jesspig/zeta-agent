const solid = await import("solid-js");
console.log(solid.createMemo.toString().includes("Owner = createOwner()") ? "SERVER" : "CLIENT");
