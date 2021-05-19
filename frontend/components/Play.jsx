import React, { Component } from 'react'
import superagent from 'superagent'

import { pick } from '../../util'
import GameEvents from '../GameEvents'
import { styleText } from '../colors'

export default class Play extends Component {
  constructor(props) {
    super(props)
    this.state = {
      openQuestionId: null,
      questions: [],
      backgroundColorLeft: null,
      backgroundColorMiddle: null,
      backgroundColorRight: null,
    }

    this.game = new GameEvents(this.props.gameId)
  }

  componentDidMount() {
    this.game.join(this.props.player, this.props.name)
    this.game.on('update', (event) => {
      this.setState(pick(event, Object.keys(this.state)))
    })
  }

  async makeChoice(choice) {
    const resp = await superagent.post('/api/games/' + this.props.gameId + '/choose')
      .send({
        questionId: this.state.openQuestionId,
        player: this.props.player,
        choice: choice,
      })
    this.setState(pick(resp, Object.keys(this.state)))
  }

  render() {
    const question = this.state.openQuestionId && this.state.questions.filter((q) => q._id === this.state.openQuestionId)[0]
    const buttonMiddleTitle = this.props.buttonMiddleTitle || '🏝'
    return (
      <div class="container">
        <div>
          <h3>Question: {question && styleText(question.text, this.state)}</h3>
        </div>
        <div>
          <button
            className="control"
            onClick={(e) => this.makeChoice('a')}
            disabled={!question}
          >{this.props.buttonLeftTitle || 'Left'}</button>
          <button
            className="control"
            onClick={(e) => this.makeChoice(null)}
            disabled={!question}
          >
          {
            /\p{Extended_Pictographic}/u.test(buttonMiddleTitle)
              ? <span style={{verticalAlign: "middle", fontSize: '1.05em'}}>{buttonMiddleTitle}</span>
              : buttonMiddleTitle
          }
          </button>
          <button
            className="control"
            onClick={(e) => this.makeChoice('b')}
            disabled={!question}
          >{this.props.buttonRightTitle || 'Right'}</button>
        </div>
      </div>
    )
  }
}
 
