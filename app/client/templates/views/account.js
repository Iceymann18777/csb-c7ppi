/**
Template Controllers

@module Templates
*/

/**
Watches custom events

@param {Object} newDocument  the account object with .jsonInterface
*/
var addLogWatching = function(newDocument) {
  var contractInstance = new web3.eth.Contract(
    newDocument.jsonInterface,
    newDocument.address
  );
  var blockToCheckBack =
    (newDocument.checkpointBlock || 0) - ethereumConfig.rollBackBy;

  if (blockToCheckBack < 0) blockToCheckBack = 0;

  console.log(
    'EVENT LOG:  Checking Custom Contract Events for ' +
      newDocument.address +
      ' (_id: ' +
      newDocument._id +
      ') from block # ' +
      blockToCheckBack
  );

  // delete the last logs until block -500
  _.each(
    Events.find({
      _id: { $in: newDocument.contractEvents || [] },
      blockNumber: { $exists: true, $gt: blockToCheckBack }
    }).fetch(),
    function(log) {
      if (log) Events.remove({ _id: log._id });
    }
  );

  var subscription = contractInstance.events.allEvents({
    fromBlock: blockToCheckBack,
    toBlock: 'latest'
  });
  // get past logs, to set the new blockNumber
  var currentBlock = EthBlocks.latest.number;

  contractInstance.getPastEvents('allEvents', function(error, logs) {
    if (!error) {
      // update last checkpoint block
      CustomContracts.update(
        { _id: newDocument._id },
        {
          $set: {
            checkpointBlock:
              (currentBlock || EthBlocks.latest.number) -
              ethereumConfig.rollBackBy
          }
        }
      );
    }
  });

  subscription.on('data', function(log) {
    var id = Helpers.makeId(
      'log',
      web3.utils.sha3(
        log.logIndex + 'x' + log.transactionHash + 'x' + log.blockHash
      )
    );

    if (log.removed) {
      Events.remove(id);
    } else {
      _.each(log.returnValues, function(value, key) {
        // if bignumber
        if (
          (_.isObject(value) || value instanceof BigNumber) &&
          value.toFormat
        ) {
          value = value.toString(10);
          log.returnValues[key] = value;
        }
      });

      // store right now, so it could be removed later on, if removed: true
      Events.upsert(id, log);

      // update events timestamp
      web3.eth.getBlock(log.blockHash, function(err, block) {
        if (!err) {
          Events.update(id, { $set: { timestamp: block.timestamp } });
        }
      });
    }
  });

  return subscription;
};

Template['views_account'].onRendered(function() {
  console.timeEnd('renderAccountPage');
});

Template['views_account'].onDestroyed(function() {
  // stop watching custom events, on destroy
  if (this.customEventSubscription) {
    this.customEventSubscription.unsubscribe();
    this.customEventSubscription = null;
    TemplateVar.set('watchEvents', false);
  }
});

Template['views_account'].helpers({
  /**
    Get the current selected account

    @method (account)
    */
  account: function() {
    return Helpers.getAccountByAddress(FlowRouter.getParam('address'));
  },
  /**
    Get the current jsonInterface, or use the wallet jsonInterface

    @method (jsonInterface)
    */
  jsonInterface: function() {
    return this.owners ? _.clone(walletInterface) : _.clone(this.jsonInterface);
  },
  /**
    Get the pending confirmations of this account.

    @method (pendingConfirmations)
    */
  pendingConfirmations: function() {
    return _.pluck(
      PendingConfirmations.find({
        operation: { $exists: true },
        confirmedOwners: { $ne: [] },
        from: this.address
      }).fetch(),
      '_id'
    );
  },
  /**
    Return the daily limit available today.

    @method (availableToday)
    */
  availableToday: function() {
    return new BigNumber(this.dailyLimit || '0', 10)
      .minus(new BigNumber(this.dailyLimitSpent || '0', '10'))
      .toString(10);
  },
  /**
    Show dailyLimit section

    @method (showDailyLimit)
    */
  showDailyLimit: function() {
    return (
      this.dailyLimit && this.dailyLimit !== ethereumConfig.dailyLimitDefault
    );
  },
  /**
    Show requiredSignatures section

    @method (showRequiredSignatures)
    */
  showRequiredSignatures: function() {
    return this.requiredSignatures && this.requiredSignatures > 1;
  },
  /**
    Link the owner either to send or to the account itself.

    @method (ownerLink)
    */
  ownerLink: function() {
    var owner = String(this);
    if (Helpers.getAccountByAddress(owner))
      return FlowRouter.path('account', { address: owner });
    else return FlowRouter.path('sendTo', { address: owner });
  },
  /**
    Get all tokens

    @method (tokens)
    */
  tokens: function() {
    var query = {};
    query['balances.' + this._id] = { $exists: true };
    return Tokens.find(query, { sort: { name: 1 } });
  },
  /**
    Get the tokens balance

    @method (formattedTokenBalance)
    */
  formattedTokenBalance: function(e) {
    var account = Template.parentData(2);

    return this.balances && Number(this.balances[account._id]) > 0
      ? Helpers.formatNumberByDecimals(
          this.balances[account._id],
          this.decimals
        ) +
          ' ' +
          this.symbol
      : false;
  },
  /**
    Checks if this is Owned

    @method (ownedAccount)
    */
  ownedAccount: function() {
    return (
      EthAccounts.find({ address: this.address.toLowerCase() }).count() > 0
    );
  },
  /**
    Gets the contract events if available

    @method (customContract)
    */
  customContract: function() {
    return CustomContracts.findOne({ address: this.address.toLowerCase() });
  },
  /**
     Displays ENS names with triangles

     @method (nameDisplay)
     */
  displayName: function() {
    return this.ens
      ? this.name
          .split('.')
          .slice(0, -1)
          .reverse()
          .join(' ??? ')
      : this.name;
  }
});

var accountClipboardEventHandler = function(e) {
  if (Session.get('tmpAllowCopy') === true) {
    Session.set('tmpAllowCopy', false);
    return true;
  } else {
    e.preventDefault();
  }

  function copyAddress() {
    var copyTextarea = document.querySelector('.copyable-address span');
    var selection = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(copyTextarea);
    selection.removeAllRanges();
    selection.addRange(range);

    try {
      document.execCommand('copy');

      GlobalNotification.info({
        content: 'i18n:wallet.accounts.addressCopiedToClipboard',
        duration: 3
      });
    } catch (err) {
      GlobalNotification.error({
        content: 'i18n:wallet.accounts.addressNotCopiedToClipboard',
        closeable: false,
        duration: 3
      });
    }
    selection.removeAllRanges();
  }

  if (Helpers.isOnMainNetwork()) {
    Session.set('tmpAllowCopy', true);
    copyAddress();
  } else {
    EthElements.Modal.question({
      text: new Spacebars.SafeString(
        TAPi18n.__('wallet.accounts.modal.copyAddressWarning')
      ),
      ok: function() {
        Session.set('tmpAllowCopy', true);
        copyAddress();
      },
      cancel: true,
      modalQuestionOkButtonText: TAPi18n.__('wallet.accounts.modal.buttonOk'),
      modalQuestionCancelButtonText: TAPi18n.__(
        'wallet.accounts.modal.buttonCancel'
      )
    });
  }
};

Template['views_account'].events({
  /**
    Clicking the delete button will show delete modal

    @event click button.delete
    */
  'click button.delete': function(e, template) {
    var data = this;

    EthElements.Modal.question({
      text: new Spacebars.SafeString(
        TAPi18n.__('wallet.accounts.modal.deleteText') +
          '<br><input type="text" class="deletionConfirmation" autofocus="true">'
      ),
      ok: function() {
        if ($('input.deletionConfirmation').val() === 'delete') {
          Wallets.remove(data._id);
          CustomContracts.remove(data._id);

          FlowRouter.go('dashboard');
          return true;
        }
      },
      cancel: true
    });
  },
  /**
    Clicking the name, will make it editable

    @event click .edit-name
    */
  'click .edit-name': function(e) {
    // make it editable
    $(e.currentTarget).attr('contenteditable', 'true');
  },
  /**
    Prevent enter

    @event keypress .edit-name
    */
  'keypress .edit-name': function(e) {
    if (e.keyCode === 13) e.preventDefault();
  },
  /**
    Bluring the name, will save it

    @event blur .edit-name, keyup .edit-name
    */
  'blur .edit-name, keyup .edit-name': function(e) {
    if (!e.keyCode || e.keyCode === 13) {
      var $el = $(e.currentTarget);
      var text = $el.text();

      if (_.isEmpty(text)) {
        text = TAPi18n.__('wallet.accounts.defaultName');
      }

      // Save new name
      Wallets.update(this._id, {
        $set: {
          name: text
        }
      });
      EthAccounts.update(this._id, {
        $set: {
          name: text
        }
      });
      CustomContracts.update(this._id, {
        $set: {
          name: text
        }
      });

      // make it non-editable
      $el.attr('contenteditable', null);
    }
  },
  /**
    Click to copy the code to the clipboard

    @event click a.create.account
    */
  'click .copy-to-clipboard-button': accountClipboardEventHandler,

  /**
    Tries to copy account token.

    @event copy .copyable-address span
    */
  'copy .copyable-address': accountClipboardEventHandler,

  /**
    Click to reveal QR Code

    @event click a.create.account
    */
  'click .qrcode-button': function(e) {
    e.preventDefault();

    // Open a modal showing the QR Code
    EthElements.Modal.show({
      template: 'views_modals_qrCode',
      data: {
        address: this.address
      }
    });
  },

  /**
    Click to reveal the jsonInterface

    @event click .interface-button
    */
  'click .interface-button': function(e) {
    e.preventDefault();
    var jsonInterface = this.owners
      ? _.clone(walletInterface)
      : _.clone(this.jsonInterface);

    //clean ABI from circular references
    var cleanJsonInterface = _.map(jsonInterface, function(e, i) {
      return _.omit(e, 'contractInstance');
    });

    // Open a modal showing the QR Code
    EthElements.Modal.show({
      template: 'views_modals_interface',
      data: {
        jsonInterface: cleanJsonInterface
      }
    });
  },
  /**
    Click watch contract events

    @event change button.toggle-watch-events
    */
  'change .toggle-watch-events': function(e, template) {
    e.preventDefault();

    if (template.customEventSubscription) {
      template.customEventSubscription.unsubscribe();
      template.customEventSubscription = null;
      TemplateVar.set('watchEvents', false);
    } else {
      template.customEventSubscription = addLogWatching(this);
      TemplateVar.set('watchEvents', true);
    }
  }
});
