#!/usr/bin/env node
import process from "node:process";
import { runWranglerRsCli } from "./rust.js";

process.exit(runWranglerRsCli());
