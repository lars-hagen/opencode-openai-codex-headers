// opencode plugin entry.
//
// opencode's plugin loader iterates every export of the entry module and
// requires each to be a plugin function (it throws "Plugin export is not a
// function" otherwise). src/index.ts intentionally exports constants and helpers
// for the tests and benchmark, so it cannot be the entry. This module re-exports
// only the default plugin, giving the loader a namespace of exactly one function.
export { default } from "./index.ts"
