# :star:Hound Importer
Import data from SharpHound and AzureHound using CLI instead of GUI [BloodHound](https://github.com/BloodHoundAD/BloodHound) using "BloodHound's code".

**This project has most of its code butchered straight from BloodHound project.** Therefore big thanks to original authors and enjoy most up-to-date CLI import experience compatible with BloodHound 4.2.

# Install

 1. Clone the repository including it's submodule: `git clone --recurse-submodules -j8 https://github.com/malacupa/starhound-importer`
 2. Make sure you have your neo4j installed
 3. Install Node.js version 16. I recommend installing and managing Node.js using [nvm](https://github.com/nvm-sh/nvm#installing-and-updating)
 4. Run `npm install --save-dev` to install all dependencies
 5. Run `npm run build` to transpile to JS code compatible with Node.js 16

Now, you should have new file in `bin/main.js` you can use.

# Run
Importing is a little silly with this tool and it's 4-step process. You could skip some steps or run them multiple times but for fastest import, I recommend following this:

 1. Setup your environment variables: `NEOPWD` (neo4j connection password, required), `NEOUSER` (neo4j connection username, optional), `NEOURL` (neo4j connection URL, optional)
 2. Run `node bin/main.js preprocess` to create DB schema
 3. Run `node bin/main.js <bhdata.json>` how many times you need to import all JSON files from BloodHound/AzureHound
 4. Run `node bin/main.js postprocess` to perform post-processing and add some more edges on your data. This may be the slowest part

You can also replace step 3. with something like: `find ../my/bloodhoud/data/ -name '*.json' -exec node bin/main.js {} \;`

# Alternative tools

  * [BloodHound](https://github.com/BloodHoundAD/BloodHound) the original GUI BloodHound, use this as your default if possible.
  * [bloodhound-import](https://github.com/fox-it/bloodhound-import) in Python by dirkjanm. Implements the import logic from scratch. 

# License
This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see http://www.gnu.org/licenses/.
