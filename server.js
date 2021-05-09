const express = require('express')
const bodyParser = require('body-parser')
const crypto = require('crypto')
const mongoose = require('mongoose')
const http = require('http')
const generateWordId = require('faster-word-id')
const WebSocket = require('ws')

const Game = require('./models/Game')
const { getMarkup } = require('./frontend')
const { pick } = require('./util')
const { renderGameJson } = require('./game')
const { makeManager2 } = require('./manager')

mongoose.connect(process.env.MONGODB_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  useCreateIndex: true,
  useFindAndModify: false,
}).then(() => console.log('MongoDB connected'))

const app = express()
const manager = makeManager2()

app.use('/static', express.static('frontend/dist'))
app.use('/', express.static('public'))

app.use(bodyParser.urlencoded({extended: true}))
app.use(bodyParser.json())

app.use(function (err, req, res, next) {
  if (!err.code || err.code >= 500) {
    console.error('Unrecognized error!', err.stack)
    res.status(500).json({ error: 'Internal server error' })
  } else {
    res.status(err.code).json({ error: err.message })
  }
})

function makeWebError(status, message) {
  const err = new Error(message)
  err.code = status
  return err
}

app.post('/api/games/:id', async (req, res) => {
  const gameId = req.params.id
  const adminModifiable = pick(req.body, [
    'questions', 'playerRegex', 'playerRegexMessage',
    'openQuestionId',
  ])

  const game = await Game.findOneAndUpdate({
    gameId,
    adminCode: req.query.adminCode,
  }, adminModifiable, { upsert: false, new: true })

  // Could also be adminCode mis-match.
  if (!game) { throw makeWebError(404, 'Not found') }
  res.json(renderGameJson(game))

  if ('openQuestionId' in req.body) {
    // update game state.
    manager.broadcastUpdate(gameId, renderGameJson(game))
  }
})

app.post('/api/games/:id/choose', async (req, res) => {
  const gameId = req.params.id
  const choice = req.body.choice
  const player = req.body.player
  const questionId = req.body.questionId

  if (!questionId || !player) { throw makeWebError(400, 'Missing questionId or player') }

  const patch = {}
  if (choice === null) {
    patch['$pull'] = {
      [`responses.${questionId}.a`]: player,
      [`responses.${questionId}.b`]: player,
    }
  } else if (choice === 'a') {
    patch['$pull'] = {
      [`responses.${questionId}.b`]: player,
    }
    patch['$addToSet'] = {
      [`responses.${questionId}.a`]: player,
    }
  } else if (choice === 'b') {
    patch['$pull'] = {
      [`responses.${questionId}.a`]: player,
    }
    patch['$addToSet'] = {
      [`responses.${questionId}.b`]: player,
    }
  } else {
    return res.status(400).json({ error: 'Invalid choice' })
  }

  const game = await Game.findOneAndUpdate({ gameId, openQuestionId: questionId },
    patch, { upsert: false, new: true })
  // Could also be that the question ID does not match the open one.
  if (!game) { throw makeWebError(404, 'Not found') }
  const gameJson = renderGameJson(game)
  res.json(gameJson)
  manager.broadcastUpdate(gameId, gameJson)
})

app.get('/api/games/:id', async (req, res) => {
  const game = await Game.findOne({ gameId: req.params.id })
  if (!game) {
    throw makeWebError(404, 'Not found')
  }
  res.json(renderGameJson(game))
})

app.post('/:id/join', async (req, res) => {
  const gameId = req.params.id
  const game = await Game.findOne({ gameId })
  if (!game) { return res.redirect('/') }

  const player = req.body.player
  const name = req.body.name
  const uriParams = 'player=' + encodeURIComponent(player) + '&name=' + encodeURIComponent(name)

  if (!player) {
    return res.redirect('/' + gameId + '?state=errorPlayer&' + uriParams)
  }
  if (game.playerRegex && !player.match(game.playerRegex)) {
    return res.redirect('/' + gameId + '?state=errorPlayerRegex&' + uriParams)
  }
  if (!name) {
    return res.redirect('/' + gameId + '?state=errorPlayerName&' + uriParams)
  }

  const newGame = await Game.findOneAndUpdate({ gameId }, {
    $addToSet: { players: player },
  }, { new: true, upsert: false })

  // res.json({
  //   player,
  //   name,
  //   ...renderGameJson(game),
  // })

  res.redirect('/' + gameId + '/play?' + uriParams)
})

app.get('/:id/manage-:adminCode', async (req, res) => {
  const game = await Game.findOne({ gameId: req.params.id, adminCode: req.params.adminCode })
  if (!game) { return res.redirect('/' + req.params.id) }

  const markup = getMarkup({
    gameId: game.gameId,
    adminCode: game.adminCode,
    page: 'manage',
    testInfo: generateWordId(),
  })
  res.end(markup)
})

app.get('/:id/present', async (req, res) => {
  const game = await Game.findOne({ gameId: req.params.id })

  if (!game) { res.redirect('/') }
  const markup = getMarkup({
    page: 'present',
    ...renderGameJson(game),
  })
  res.end(markup)
})

app.get('/:id/play', async (req, res) => {
  const player = req.query.player
  const name = req.query.name
  const game = await Game.findOne({ gameId: req.params.id })

  if (!game) { res.redirect('/') }
  const markup = getMarkup({
    page: 'play',
    player,
    name,
    ...renderGameJson(game),
  })
  res.end(markup)
})

app.get('/:id/:adminCode', (req, res) => {
  res.redirect(`/${req.params.id}/manage-${req.params.adminCode}`)
})

app.get('/:id', async (req, res) => {
  const game = await Game.findOne({ gameId: req.params.id })
  if (!game) { return res.redirect('/') }
  const markup = getMarkup({
    page: 'lobby',
    ...renderGameJson(game),
  })
  res.end(markup)
})

app.get('/', (req, res) => {
  const markup = getMarkup({
    page: 'index',
    testInfo: crypto.randomUUID(),
  })
  res.end(markup)
})

const server = http.createServer(app);
const wss = new WebSocket.Server({
  clientTracking: true,
  noServer: true,
});

wss.on('connection', function connection(ws) {
  ws.on('close', async function(message) {
    console.log(message)
    try {
      manager.removePlayer(ws.gameId, ws.player)
      const game = await Game.findOne({ gameId: ws.gameId })
      manager.broadcastUpdate(gameId, renderGameJson(game))
    } catch (err) {
      console.error('Failed to handle close', ws.gameId, ws.player)
    }
  })

  ws.on('message', async function incoming(message) {
    console.log('received: %s', message);
    let msg
    try {
      msg = JSON.parse(message)
    } catch(err) {
      console.error('Failed to parse message', message);
    }

    if (msg.event === 'join') {
      const { gameId, player, name } = msg
      const game = await Game.findOne({ gameId })
      if (!game) {
        ws.send({ event: 'error', error: 'Game not found' })
        return
      }
      if (manager.hasPlayer(gameId, msg)) {
        // pass
        console.log('Game already has player!', gameId, player, name)
      } else {
        // addPlayer: (gameId, player, name, lastMessageTime, ws) => {
        manager.addPlayer(gameId, player, name, Date.now(), ws)
      }
      manager.broadcastUpdate(gameId, renderGameJson(game))
    }
    else if (msg.event === 'ping') {
      console.log('got ping', ws.player)
    }
    else {
      console.warn('Unrecognized event', msg)
    }
  });
});

server.on('upgrade', function (request, socket, head) {
  console.log('Parsing upgrade request...');
  wss.handleUpgrade(request, socket, head, function (ws) {
    wss.emit('connection', ws, request);
  });
});

const listener = server.listen(process.env.PORT || 3000, () => {
  console.log(`Listening on ${listener.address().port}`)
})
