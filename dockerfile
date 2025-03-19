# 1) Choose a base image (e.g., Node 16 or 18)
FROM node:18

# 2) Create app directory within the container
WORKDIR /app

# 3) Copy package.json + package-lock.json first for caching
COPY package*.json ./

# 4) Install dependencies
RUN npm install

# 5) Copy the rest of your app files
COPY . .

# 6) Expose the port your Node.js app listens on (optional in newer Docker versions)
EXPOSE 3000

# 7) Define the command to start your app
CMD ["npm", "start"]
