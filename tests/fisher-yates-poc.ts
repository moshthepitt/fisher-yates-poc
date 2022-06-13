import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { expect } from "chai";
import { FisherYatesPoc } from "../target/types/fisher_yates_poc";

describe("fisher-yates-poc", () => {
  // Configure the client to use the local cluster.
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.FisherYatesPoc as Program<FisherYatesPoc>;

  const BASE_DATA_SIZE = 8 + 32 + 4 + 4;
  const DATA_LINE_SIZE = 32;

  const genKeys = (num: number) => {
    const result: anchor.web3.PublicKey[] = [];
    for (let index = 0; index < num; index++) {
      const keypair = new anchor.web3.Keypair();
      result.push(keypair.publicKey);
    }
    return result;
  };

  const chunkArray = <T>(array: T[], chunkSize: number): T[][] => {
    return Array.from(
      { length: Math.ceil(array.length / chunkSize) },
      (_, index) => array.slice(index * chunkSize, (index + 1) * chunkSize)
    );
  };

  // incidentally, this is the fisher yates algorithm
  const shuffleArray = <T>(array: T[]): T[] => {
    let currentIndex = array.length;
    let randomIndex: number;
    // While there remain elements to shuffle...
    while (currentIndex != 0) {
      // Pick a remaining element...
      randomIndex = Math.floor(Math.random() * currentIndex);
      currentIndex--;

      // And swap it with the current element.
      [array[currentIndex], array[randomIndex]] = [
        array[randomIndex],
        array[currentIndex],
      ];
    }
    return array;
  };

  const getData = async (
    dataAccountKey: anchor.web3.PublicKey,
    numItems: number
  ) => {
    const rawConfigAccountInfo =
      await program.provider.connection.getAccountInfo(dataAccountKey);
    let retrievedKeys: anchor.web3.PublicKey[] = [];
    for (let index = 0; index < numItems; index++) {
      const thisSlice = rawConfigAccountInfo.data.slice(
        BASE_DATA_SIZE + 4 + DATA_LINE_SIZE * index,
        BASE_DATA_SIZE + 4 + DATA_LINE_SIZE * (index + 1)
      );
      const retrievedKey = new anchor.web3.PublicKey(thisSlice);
      retrievedKeys.push(retrievedKey);
    }
    return retrievedKeys;
  };

  const createDataAccountInstruction = async (
    accountAddress: anchor.web3.PublicKey,
    payer: anchor.web3.PublicKey,
    maxItems: number,
    program: Program<FisherYatesPoc>
  ): Promise<anchor.web3.TransactionInstruction> => {
    const size =
      BASE_DATA_SIZE +
      4 +
      maxItems * DATA_LINE_SIZE +
      4 +
      Math.ceil(maxItems / 8);

    return anchor.web3.SystemProgram.createAccount({
      fromPubkey: payer,
      newAccountPubkey: accountAddress,
      space: size,
      lamports:
        await program.provider.connection.getMinimumBalanceForRentExemption(
          size
        ),
      programId: program.programId,
    });
  };

  const initializeIx = async (maxItems: number) => {
    const newAcc = new anchor.web3.Keypair();
    const createDataAccIx = createDataAccountInstruction(
      newAcc.publicKey,
      provider.wallet.publicKey,
      maxItems,
      program
    );
    const initIx = program.methods
      .initialize(maxItems)
      .accounts({
        data: newAcc.publicKey,
      })
      .instruction();

    return {
      instructions: await Promise.all([createDataAccIx, initIx]),
      signers: [newAcc],
      dataAccountKey: newAcc.publicKey,
    };
  };

  const addItemsIxs = async (
    index: number,
    items: anchor.web3.PublicKey[],
    dataAccountKey: anchor.web3.PublicKey
  ) => {
    let instructionPromises: Promise<anchor.web3.TransactionInstruction>[] = [];
    let currentIndex = index;
    const shuffledItems = shuffleArray(items);
    for (let idx = 0; idx < shuffledItems.length; idx++) {
      const element = shuffledItems[idx];
      const addIx = program.methods
        .addItem(element, new anchor.BN(currentIndex))
        .accounts({
          data: dataAccountKey,
        })
        .instruction();
      instructionPromises.push(addIx);
      currentIndex += 1;
    }
    return await Promise.all(instructionPromises);
  };

  const showItem = async (
    index: number,
    dataAccountKey: anchor.web3.PublicKey
  ) => {
    return program.methods
      .showItem(index)
      .accounts({
        data: dataAccountKey,
      })
      .instruction();
  };

  const selectItemIx = async (dataAccountKey: anchor.web3.PublicKey) => {
    return program.methods
      .selectItem()
      .accounts({
        recentSlothashes: anchor.web3.SYSVAR_SLOT_HASHES_PUBKEY,
        data: dataAccountKey,
      })
      .instruction();
  };

  it("Is works!", async () => {
    // create data account
    const numItems = 10;
    const result = await initializeIx(numItems);
    const tx = new anchor.web3.Transaction().add(...result.instructions);
    const txId = await program.provider.sendAndConfirm(tx, result.signers);
    console.log("Create account", txId);

    // add items
    const items = genKeys(numItems);
    const instructions = await addItemsIxs(0, items, result.dataAccountKey);

    const chunks = chunkArray(instructions, 15);
    for (let index = 0; index < chunks.length; index++) {
      const element = chunks[index];
      const itemsTx = new anchor.web3.Transaction().add(...element);
      const itemsTxId = await program.provider.sendAndConfirm(itemsTx);
      console.log(
        "Add",
        element.length,
        "item(s); chunk",
        index + 1,
        "of",
        chunks.length,
        ";",
        itemsTxId
      );
    }

    // test account is populated correctly
    const account = await program.account.dataAccount.fetch(
      result.dataAccountKey
    );
    expect(provider.wallet.publicKey.toBase58()).to.eq(
      account.authority.toBase58()
    );
    expect(account.maxItems).to.eq(numItems);
    expect(account.numItems).to.eq(numItems);

    const retrievedKeys = await getData(
      result.dataAccountKey,
      account.numItems
    );

    expect(items.map((it) => it.toBase58()).sort()).to.deep.eq(
      retrievedKeys.map((it) => it.toBase58()).sort()
    );
    // console.log(
    //   "1>>>>>>>>>>",
    //   retrievedKeys.map((it) => it.toBase58())
    // );

    // test view instruction
    console.log("item ", retrievedKeys.map((it) => it.toBase58())[4]);
    const showItemIx = await showItem(4, result.dataAccountKey);
    const tx1 = new anchor.web3.Transaction().add(showItemIx);
    const tx1Id = await program.provider.sendAndConfirm(tx1);
    console.log("Retrieve item", tx1Id);

    // test selection
    const numToSelect = 5;

    for (let index = 0; index < numToSelect; index++) {
      const selectedItemIx = await selectItemIx(result.dataAccountKey);
      const tx2 = new anchor.web3.Transaction().add(selectedItemIx);
      const tx2Id = await program.provider.sendAndConfirm(tx2);
      console.log("Select item", tx2Id);
    }

    // const selectedItemIx = await selectItemIx(result.dataAccountKey);
    // const tx2 = new anchor.web3.Transaction().add(selectedItemIx);
    // const tx2Id = await program.provider.sendAndConfirm(tx2);
    // console.log("Select item", tx2Id);

    // const selectedItemIx2 = await selectItemIx(result.dataAccountKey);
    // const tx3 = new anchor.web3.Transaction().add(selectedItemIx2);
    // const tx3Id = await program.provider.sendAndConfirm(tx3);
    // console.log("Select item again", tx3Id);

    const account2 = await program.account.dataAccount.fetch(
      result.dataAccountKey
    );
    const retrievedKeys2 = await getData(
      result.dataAccountKey,
      account.numItems
    );
    expect(retrievedKeys2.map((it) => it.toBase58()).sort()).to.deep.eq(
      retrievedKeys.map((it) => it.toBase58()).sort()
    );
    // console.log(
    //   "2>>>>>>>>>>",
    //   retrievedKeys2.map((it) => it.toBase58())
    // );
    expect(account2.maxItems).to.eq(numItems);
    expect(account2.numItems).to.eq(numItems);
    expect(account2.usedItems).to.eq(numToSelect);
  });
});
