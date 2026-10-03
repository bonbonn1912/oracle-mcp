import oracledb from "oracledb";

let releaseFirstQuery;
const firstQueryGate = new Promise((resolve) => {
  releaseFirstQuery = resolve;
});
let hasBlockedFirstQuery = false;

process.on("message", (message) => {
  if (message?.type === "release-first-query") releaseFirstQuery();
});

oracledb.getConnection = async () => ({
  callTimeout: 0,
  module: "",
  isHealthy: () => true,
  close: async () => {},
  commit: async () => {},
  rollback: async () => {},
  execute: async (sql, _binds, options = {}) => {
    process.send?.({ type: "sql", sql: String(sql) });
    if (options.resultSet) {
      const isBlockedQuery = /BLOCK_QUEUE_TEST/i.test(String(sql));
      let fetched = false;
      return {
        metaData: [{ name: "VALUE" }],
        resultSet: {
          metaData: [{ name: "VALUE" }],
          getRows: async (count) => {
            if (isBlockedQuery && !hasBlockedFirstQuery) {
              hasBlockedFirstQuery = true;
              process.send?.({ type: "blocked" });
              await firstQueryGate;
            }
            if (fetched) return [];
            fetched = true;
            return [["ok"]].slice(0, count);
          },
          close: async () => {},
        },
      };
    }
    return { rowsAffected: 1 };
  },
});
