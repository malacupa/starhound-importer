# *Hound Importer
Import data from SharpHound and AzureHound using CLI instead of GUI (BloodHound)[https://github.com/BloodHoundAD/BloodHound] using "BloodHound's code".

**This project has most of its code butchered straight from BloodHound's code.** Therefore big thanks to original authors and enjoy most up-to-date CLI import experience compatible with BloodHound 4.2.

# Install

 1. Make sure you have your neo4j installed
 2. Install Node.js version 16. I recommend installing and managing Node.js using (nvm)[https://github.com/nvm-sh/nvm#installing-and-updating]
 3. Run `npm install` to install all dependencies
 4. Run `npm run build` to transpile to JS code compatible with Node.js 16

Now, you should have new file in `bin/main.js`

# Run
Importing is a little silly with this tool and it's 4-step process. You could skip some steps or run them multiple times but for fastest import, I recommend following this:

 1. Setup your environment variables: `NEOPWD` (neo4j connection password, required), `NEOUSER` (neo4j connection username, optional), `NEOURL` (neo4j connection URL, optional)
 2. Run `node bin/app.js preprocess` to create DB schema
 3. Run `node bin/app.js <bhdata.json>` how many times you need to import all JSON files from BloodHound/AzureHound
 4. Run `node bin/app.js postprocess` to perform post-processing and add some more edges on your data. This may be the slowest part

# License
This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this program. If not, see http://www.gnu.org/licenses/.
