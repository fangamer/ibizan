if not process.env.token
  console.log 'Error: Specify token in environment'
  process.exit1

botkit = require 'botkit'
os = require 'os'
