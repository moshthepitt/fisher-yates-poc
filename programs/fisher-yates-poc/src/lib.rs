use anchor_lang::prelude::*;
use anchor_lang::solana_program::{keccak::hashv, sysvar::slot_hashes};

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

// constants
pub const BASE_SIZE: usize = 8 + // discriminator
    32 + // authority pubkey
    4 + // max items
    4; // num items

pub const DATA_LINE_SIZE: usize = 32;

// functions
pub fn get_line_item(
    index: usize,
    data: &[u8],
    max_number: u32,
) -> core::result::Result<Pubkey, Error> {
    require_gte!(max_number as usize, index);

    let start_position = BASE_SIZE + 4 + index * DATA_LINE_SIZE;
    let end_position = BASE_SIZE + 4 + (index + 1) * DATA_LINE_SIZE;

    let data_array = &mut data[start_position..end_position].to_vec();
    let mut full_item: Vec<u8> = vec![32, 0, 0, 0];
    full_item.append(data_array);
    let config_line: Pubkey = Pubkey::try_from_slice(full_item.as_slice())?;

    Ok(config_line)
}

// Generate random number using Linear Congruential Method
pub fn generate_random_number(
    multiplier: u32,
    increment: u32,
    modulus: u32,
    min: u32,
    max: u32,
) -> Result<u64> {
    let mut x0 = 0;
    let range = min..max;

    for _ in 0.. {
        x0 = (multiplier * x0 + increment) % modulus;
        // break out as soon as we have something usable
        if range.contains(&x0) {
            return Ok(x0 as u64);
        }
    }

    return Err(Errors::RandomNumberNotFound.into());
}

// the program itself

#[program]
pub mod fisher_yates_poc {
    use super::*;

    /// Create a large on-chain array
    pub fn initialize(ctx: Context<Initialize>, max_items: u32) -> Result<()> {
        let data_account = &mut ctx.accounts.data;
        data_account.authority = ctx.accounts.authority.key();
        data_account.max_items = max_items;
        data_account.num_items = 0;
        data_account.used_items = 0;
        Ok(())
    }

    /// Add items to the large on-chain array
    pub fn add_item(ctx: Context<AddItem>, item: Pubkey, index: u64) -> Result<()> {
        let data_account = &mut ctx.accounts.data;

        require_gt!(data_account.max_items as u64, index);

        // get data as slice
        let account = data_account.to_account_info();
        let mut items_data = account.data.try_borrow_mut().unwrap();

        // increment number of stored items
        let new_count = match get_line_item(index as usize, &items_data, data_account.max_items) {
            Err(_error) => data_account.num_items + 1, // this index has never been allocated
            Ok(_value) => data_account.num_items,
        };
        data_account.num_items = new_count;

        let item_as_vec = item.try_to_vec()?;
        let serialized_item: &[u8] = &item_as_vec.as_slice();

        // insert serialized_item into its exact position in items_data
        let position = BASE_SIZE + 4 + (index as usize) * DATA_LINE_SIZE;
        let array_slice: &mut [u8] = &mut items_data[position..position + DATA_LINE_SIZE];
        array_slice.copy_from_slice(serialized_item);

        Ok(())
    }

    /// Return an item
    pub fn show_item(ctx: Context<ShowItem>, index: u32) -> Result<Pubkey> {
        let data_account = &mut ctx.accounts.data;
        require_gt!(data_account.max_items, index);

        // get data as slice
        let account = data_account.to_account_info();
        let items_data = account.data.try_borrow().unwrap();
        let position = BASE_SIZE + 4 + (index as usize) * DATA_LINE_SIZE;
        let array_slice: &[u8] = &items_data.get(position..position + DATA_LINE_SIZE).unwrap();
        let the_pubkey = Pubkey::try_from_slice(array_slice)?;
        msg!("the_pubkey {:?}", &the_pubkey.to_string());

        Ok(the_pubkey)
    }

    /// Return an item
    pub fn select_item(ctx: Context<SelectItem>) -> Result<()> {
        let data_account = &mut ctx.accounts.data;
        require_gt!(data_account.num_items, data_account.used_items);
        let remaining = data_account.num_items - data_account.used_items;

        // Get 8 bytes of entropy from the SlotHashes sysvar
        let mut buf: [u8; 8] = [0; 8];
        buf.copy_from_slice(
            &hashv(&[
                &ctx.accounts.recent_slothashes.data.borrow(),
                &remaining.to_le_bytes(),
            ])
            .as_ref()[..8],
        );
        let entropy = u64::from_le_bytes(buf);

        let mut selected_index = data_account.used_items as u64;
        if remaining > 1 {
            let multiplier = 21;
            let incrementor = (entropy % remaining as u64) * 7;
            let modulus = 100;
            selected_index = generate_random_number(
                multiplier,
                incrementor as u32,
                modulus,
                data_account.used_items,
                data_account.num_items,
            )?;
        }

        let account = data_account.to_account_info();
        let mut items_data = account.data.try_borrow_mut().unwrap();

        // swap the element at selected_index with the element at data_account.used_items index, thus selecting it
        let selected_position = BASE_SIZE + 4 + (selected_index as usize) * DATA_LINE_SIZE;
        let next_position = BASE_SIZE + 4 + (data_account.used_items as usize) * DATA_LINE_SIZE;

        if selected_position != next_position {
            let (left, right) = items_data.split_at_mut(selected_position);
            right[0..DATA_LINE_SIZE]
                .swap_with_slice(&mut left[next_position..next_position + DATA_LINE_SIZE]);
        }

        // let array_slice: &[u8] = &items_data.get(selected_position..selected_position + DATA_LINE_SIZE).unwrap();
        let array_slice2: &[u8] = &items_data
            .get(next_position..next_position + DATA_LINE_SIZE)
            .unwrap();
        // msg!("replacement {:?}", &Pubkey::try_from_slice(array_slice).unwrap().to_string());
        msg!(
            "SELECTED {:?}",
            &Pubkey::try_from_slice(array_slice2).unwrap().to_string()
        );

        data_account.used_items += 1;

        Ok(())
    }
}

// account structs
#[derive(Accounts)]
pub struct Initialize<'info> {
    pub authority: Signer<'info>,

    #[account(zero)]
    pub data: Account<'info, DataAccount>,
}

#[derive(Accounts)]
pub struct AddItem<'info> {
    pub authority: Signer<'info>,

    #[account(mut,  has_one = authority)]
    pub data: Account<'info, DataAccount>,
}

#[derive(Accounts)]
pub struct ShowItem<'info> {
    pub data: Account<'info, DataAccount>,
}

#[derive(Accounts)]
pub struct SelectItem<'info> {
    #[account(mut)]
    pub data: Account<'info, DataAccount>,

    /// CHECK: Address is verified
    #[account(address = slot_hashes::id())]
    pub recent_slothashes: UncheckedAccount<'info>,
}

// state

#[account]
#[derive(Default)]
pub struct DataAccount {
    pub authority: Pubkey,
    pub max_items: u32,
    pub num_items: u32,
    pub used_items: u32,
    // there is a hidden field that is an array of Pubkeys (the data in the large array)
}

#[error_code]
pub enum Errors {
    #[msg("Could not find random number!")]
    RandomNumberNotFound,
}
