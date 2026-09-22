const { runFinalize } = require("./stickydisk");

runFinalize().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
