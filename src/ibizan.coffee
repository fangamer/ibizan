if not process.env.TOKEN
  console.log 'Error: Specify TOKEN in environment'
  process.exit 1

Fs = require 'fs'
Path = require 'path'
Botkit = require 'botkit'

debug = process.env.DEBUG or false
controller = Botkit.slackbot(debug: debug)
bot = controller.spawn(token: process.env.TOKEN).startRTM()

# Help responses
controller.hears [ 'help ?(.*)' ], [
  'direct_message'
  'direct_mention'
  'mention'
], (bot, msg) ->
  bot.startTyping msg
  results = []
  re = RegExp(msg.match[1], 'gi')
  for i of helpEntries
    he = helpEntries[i]
    if he.search(re) != -1
      results.push he
  bot.reply msg, results.join('\n')
  return

# Load scripts
helpEntries = []
scriptDir = Path.resolve('./src', 'scripts')
scripts = Fs.readdirSync(scriptDir).sort()
for i of scripts
  file = scripts[i]
  ext = Path.extname(file)
  path = Path.join(scriptDir, Path.basename(file, ext))
  if !require.extensions[ext]
    continue
  script = undefined
  try
    controller.log 'Loading script:', file
    script = require(path)
    # Call init function so script can set up listeners
    if typeof script.init == 'function'
      script.init controller
    else
      controller.log.error 'expected init to be a function, instead was ' + typeof script.init
    # Put the help items into the help directory
    if script.help
      helpEntries = helpEntries.concat(script.help)
  catch e
    controller.log.error 'Couldn\'t load', file, '\n', e
