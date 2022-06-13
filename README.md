# Fisher-Yates proof of concept

This repo is the result of a few hours of fun trying to do the following:

- implement a large array on-chain on Solana
- retrieve items from this array randomly using ideas from the [fisher-yates](https://en.wikipedia.org/wiki/Fisher%E2%80%93Yates_shuffle) algorithm (Incidentally, I ended up also exploring using a [linear congruential generator](https://en.wikipedia.org/wiki/Linear_congruential_generator))

## How to run

[Install Solana and Anchor](https://project-serum.github.io/anchor/getting-started/installation.html).

run `anchor test`
