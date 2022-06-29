import chai, { expect } from 'chai';
import chaiAsPromised from 'chai-as-promised';

import { setActivePinia, createPinia } from 'pinia';

import { MessageType, useMessageStore } from '@src/store/messages';

chai.use(chaiAsPromised);

describe('Message store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('supports adding, accessing, and deleting messages', () => {
    const messageStore = useMessageStore();

    const innerError = new Error('inner error');
    const ids = [
      messageStore.addError('an error', innerError),
      messageStore.addWarning('warning'),
      messageStore.addInfo('info'),
    ];

    const expected = [
      {
        type: MessageType.Error,
        title: 'an error',
        details: String(innerError),
      },
      {
        type: MessageType.Warning,
        title: 'warning',
      },
      {
        type: MessageType.Info,
        title: 'info',
      },
    ].map((ex, i) => ({ ...ex, id: String(i + 1) }));

    expect(messageStore.messages).to.have.length(5);

    ids.forEach((id, index) => {
      expect(messageStore.byID[id]).to.deep.equal(expected[index]);
    });

    messageStore.clearOne(ids[1]);
    expect(messageStore.byID).to.not.have.property(ids[1]);

    messageStore.clearAll();
    expect(messageStore.messages).to.be.empty;
  });
});
